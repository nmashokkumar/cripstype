cmake_minimum_required(VERSION 3.16)
project(flow_silero_vad LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Allow passing -DONNXRUNTIME_ROOT=/path/to/onnxruntime-linux-x64-...
set(ONNXRUNTIME_ROOT "" CACHE PATH "Path to unpacked ONNX Runtime C++ SDK")

find_path(ONNXRUNTIME_INCLUDE_DIR
  NAMES onnxruntime_cxx_api.h
  HINTS
    "${ONNXRUNTIME_ROOT}/include"
    "/usr/local/include/onnxruntime"
    "/usr/include/onnxruntime"
)

find_library(ONNXRUNTIME_LIB
  NAMES onnxruntime
  HINTS
    "${ONNXRUNTIME_ROOT}/lib"
    "/usr/local/lib"
    "/usr/lib"
)

if (NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIB)
  message(FATAL_ERROR
    "ONNX Runtime C++ SDK not found. Pass -DONNXRUNTIME_ROOT=/path/to/onnxruntime or run backend/install.sh.")
endif()

add_library(silero_vad SHARED silero_vad.cpp)
target_include_directories(silero_vad PRIVATE "${ONNXRUNTIME_INCLUDE_DIR}")
target_link_libraries(silero_vad PRIVATE "${ONNXRUNTIME_LIB}")

if (UNIX AND NOT APPLE)
  set_target_properties(silero_vad PROPERTIES
    BUILD_RPATH "${ONNXRUNTIME_ROOT}/lib"
    INSTALL_RPATH "$ORIGIN:${ONNXRUNTIME_ROOT}/lib"
  )
endif()
