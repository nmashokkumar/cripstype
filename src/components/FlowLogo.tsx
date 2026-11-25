const CRISPTYPE_LOGO_SRC = '/assets/aistudio/Gemini_Generated_Image_3etv6o3etv6o3etv_ffa8070d.png';

export function FlowLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      {/* CrispType waveform + I-beam cursor mark cropped cleanly from the shared brand logo */}
      <div className="relative w-8 h-8 rounded-[9px] overflow-hidden bg-[#121622] border border-white/10 shadow-xs shrink-0">
        <img
          src={CRISPTYPE_LOGO_SRC}
          alt="CrispType logo"
          className="w-full h-full object-cover object-left scale-[2.4] translate-x-[38%] pointer-events-none"
        />
      </div>
      {!compact && (
        <div className="flex flex-col leading-none">
          <span className="text-[18px] font-bold tracking-[-0.03em] text-[var(--flow-text)]">
            Crisp
            <span className="bg-gradient-to-r from-[#22D3EE] via-[#6366F1] to-[#A855F7] bg-clip-text text-transparent">
              Type
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
