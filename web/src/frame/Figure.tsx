/** A person as the office draws them: a head and a shirt, seen from in front. The shirt is the team's colour. */
export function Figure({ shirt, skin, size = 44 }: { shirt: string; skin: string; size?: number }) {
  return (
    <svg className="figure" width={size} height={Math.round((size * 46) / 24)} viewBox="0 0 24 46" aria-hidden="true">
      <rect x="0" y="18" width="24" height="28" rx="8" fill={shirt} />
      <circle cx="12" cy="10" r="10" fill={skin} />
    </svg>
  );
}
