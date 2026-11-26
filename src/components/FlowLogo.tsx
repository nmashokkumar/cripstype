const CRISPTYPE_FULL_LOGO_SRC = '/assets/crisptype-logo-full.png';
const CRISPTYPE_SIMPLE_LOGO_SRC = '/assets/crisptype-icon.png';

export function FlowLogo({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center justify-center select-none">
        <img
          src={CRISPTYPE_SIMPLE_LOGO_SRC}
          alt="CrispType"
          className="w-8 h-8 rounded-[9px] object-cover border border-white/10 shadow-xs pointer-events-none"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center select-none">
      <img
        src={CRISPTYPE_FULL_LOGO_SRC}
        alt="CrispType — Speech-to-Text"
        className="h-9 w-auto max-w-[168px] rounded-[9px] object-contain border border-white/10 shadow-xs pointer-events-none"
      />
    </div>
  );
}
