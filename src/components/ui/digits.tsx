/**
 * A figure whose changed characters roll up into place. Keyed by position *and* character so
 * only the characters that moved remount and animate — a key of the whole value would roll
 * every column on every tick.
 *
 * It clips itself rather than trusting a caller to: the roll starts a full line below its own
 * box, so an unclipped figure is read sliding up over whatever sits under it.
 */
export function Digits({ value }: { value: string }) {
  return (
    <span className="inline-flex overflow-hidden">
      {value.split("").map((character, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: position is half the identity — the same character in a different column is a different character
          key={`${index}-${character}`}
          className="inline-block animate-in slide-in-from-bottom-full duration-500"
        >
          {character === " " ? " " : character}
        </span>
      ))}
    </span>
  );
}
