// Monochrome barcode strip derived deterministically from the settlement signature:
// a visual encoding of the real sig bytes (receipt detail), not a scannable Code 128.
export default function Barcode({ data, height = 32 }) {
  const bars = [];
  let x = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    const w = (code % 3) + 1;        // bar width 1-3px from the char itself
    const gap = ((code >> 3) % 2) + 1; // gap 1-2px
    bars.push(<rect key={i} x={x} y={0} width={w} height={height} />);
    x += w + gap;
  }
  return (
    <svg
      className="barcode"
      width={x}
      height={height}
      viewBox={`0 0 ${x} ${height}`}
      role="img"
      aria-label={`barcode of settlement signature ${data.slice(0, 8)}`}
      preserveAspectRatio="none"
    >
      {bars}
    </svg>
  );
}
