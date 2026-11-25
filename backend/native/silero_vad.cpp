/**
 * Native C++17 Silero VAD v5 Engine (ONNX Runtime C++ API)
 *
 * Processes 16 kHz mono audio in 512-sample (32 ms) frames at native C++ speed,
 * exposing a C ABI (`libsilero_vad.so` / `.dylib` / `.dll`) callable directly
 * from Python (ctypes), Rust, Swift, Kotlin/JNI, or Electron native addons.
 */

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kSampleRate16k = 16000;
constexpr int kFrameSamples16k = 512;
constexpr int kContextSamples16k = 64;
constexpr int kStateSize = 2 * 1 * 128;

Ort::Env& shared_ort_env() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "flow_silero_vad");
  return env;
}

}  // namespace

struct SileroVadHandle {
  std::unique_ptr<Ort::Session> session;
  Ort::MemoryInfo memory_info;
  int sample_rate = kSampleRate16k;
  std::array<float, kStateSize> state{};
  std::array<float, kContextSamples16k> context{};

  SileroVadHandle(const std::string& model_path, int sr)
      : memory_info(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)),
        sample_rate(sr) {
    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(1);
    opts.SetInterOpNumThreads(1);
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

#ifdef _WIN32
    std::wstring wide_path(model_path.begin(), model_path.end());
    session = std::make_unique<Ort::Session>(shared_ort_env(), wide_path.c_str(), opts);
#else
    session = std::make_unique<Ort::Session>(shared_ort_env(), model_path.c_str(), opts);
#endif
    reset();
  }

  void reset() {
    state.fill(0.0f);
    context.fill(0.0f);
  }

  float process_frame(const float* frame_512) {
    constexpr int kTotalInput = kContextSamples16k + kFrameSamples16k;
    std::array<float, kTotalInput> input_buf{};
    std::memcpy(input_buf.data(), context.data(), sizeof(float) * kContextSamples16k);
    std::memcpy(
        input_buf.data() + kContextSamples16k,
        frame_512,
        sizeof(float) * kFrameSamples16k);

    // Save tail 64 samples as context for the next frame (Silero VAD v5 requirement)
    std::memcpy(
        context.data(),
        frame_512 + (kFrameSamples16k - kContextSamples16k),
        sizeof(float) * kContextSamples16k);

    std::array<int64_t, 2> input_shape{1, kTotalInput};
    std::array<int64_t, 3> state_shape{2, 1, 128};
    std::array<int64_t, 1> sr_shape{1};
    int64_t sr_val = static_cast<int64_t>(sample_rate);

    std::array<Ort::Value, 3> inputs = {
        Ort::Value::CreateTensor<float>(
            memory_info, input_buf.data(), input_buf.size(), input_shape.data(), input_shape.size()),
        Ort::Value::CreateTensor<float>(
            memory_info, state.data(), state.size(), state_shape.data(), state_shape.size()),
        Ort::Value::CreateTensor<int64_t>(
            memory_info, &sr_val, 1, sr_shape.data(), sr_shape.size()),
    };

    static const char* kInputNames[] = {"input", "state", "sr"};
    static const char* kOutputNames[] = {"output", "stateN"};

    auto outputs = session->Run(
        Ort::RunOptions{nullptr},
        kInputNames,
        inputs.data(),
        inputs.size(),
        kOutputNames,
        2);

    const float* prob_ptr = outputs[0].GetTensorData<float>();
    const float* next_state = outputs[1].GetTensorData<float>();
    std::memcpy(state.data(), next_state, sizeof(float) * kStateSize);

    return prob_ptr ? prob_ptr[0] : 0.0f;
  }
};

extern "C" {

#ifdef _WIN32
#define FLOW_VAD_API __declspec(dllexport)
#else
#define FLOW_VAD_API __attribute__((visibility("default")))
#endif

FLOW_VAD_API SileroVadHandle* silero_vad_create(const char* model_path, int sample_rate) {
  if (!model_path || sample_rate != kSampleRate16k) {
    return nullptr;
  }
  try {
    return new SileroVadHandle(model_path, sample_rate);
  } catch (...) {
    return nullptr;
  }
}

FLOW_VAD_API void silero_vad_reset(SileroVadHandle* handle) {
  if (handle) {
    handle->reset();
  }
}

FLOW_VAD_API float silero_vad_process_frame(SileroVadHandle* handle, const float* frame_512) {
  if (!handle || !frame_512) {
    return 0.0f;
  }
  try {
    return handle->process_frame(frame_512);
  } catch (...) {
    return 0.0f;
  }
}

/**
 * Filters raw 16 kHz Int16 PCM to retain only speech segments plus configurable
 * pre/post padding (`pad_ms`), stripping long silences before ASR inference.
 *
 * Returns 1 if speech was detected, 0 if audio was silence-only, or -1 on error.
 */
FLOW_VAD_API int silero_vad_filter_pcm(
    SileroVadHandle* handle,
    const int16_t* pcm_in,
    size_t num_samples,
    float threshold,
    int pad_ms,
    int16_t* pcm_out,
    size_t* out_samples) {
  if (!handle || !pcm_in || !pcm_out || !out_samples || num_samples < kFrameSamples16k) {
    if (out_samples) *out_samples = 0;
    return -1;
  }

  try {
    handle->reset();
    const size_t total_frames = num_samples / kFrameSamples16k;
    std::vector<uint8_t> is_speech(total_frames, 0);
    std::array<float, kFrameSamples16k> float_frame{};

    bool any_speech = false;
    for (size_t f = 0; f < total_frames; ++f) {
      const int16_t* src = pcm_in + (f * kFrameSamples16k);
      for (int i = 0; i < kFrameSamples16k; ++i) {
        float_frame[i] = static_cast<float>(src[i]) / 32768.0f;
      }
      const float prob = handle->process_frame(float_frame.data());
      if (prob >= threshold) {
        is_speech[f] = 1;
        any_speech = true;
      }
    }

    if (!any_speech) {
      *out_samples = 0;
      return 0;
    }

    // Dilate active speech masks by pad_ms on each side so word onsets/tails are never clipped
    const size_t pad_frames =
        static_cast<size_t>(std::max(1, (pad_ms * kSampleRate16k) / (1000 * kFrameSamples16k)));
    std::vector<uint8_t> keep(total_frames, 0);
    for (size_t f = 0; f < total_frames; ++f) {
      if (!is_speech[f]) continue;
      const size_t start = (f > pad_frames) ? (f - pad_frames) : 0;
      const size_t end = std::min(total_frames, f + pad_frames + 1);
      for (size_t k = start; k < end; ++k) {
        keep[k] = 1;
      }
    }

    size_t write_idx = 0;
    for (size_t f = 0; f < total_frames; ++f) {
      if (!keep[f]) continue;
      const int16_t* src = pcm_in + (f * kFrameSamples16k);
      std::memcpy(pcm_out + write_idx, src, sizeof(int16_t) * kFrameSamples16k);
      write_idx += kFrameSamples16k;
    }

    *out_samples = write_idx;
    return 1;
  } catch (...) {
    *out_samples = 0;
    return -1;
  }
}

FLOW_VAD_API void silero_vad_destroy(SileroVadHandle* handle) {
  delete handle;
}

}  // extern "C"
