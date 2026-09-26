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
