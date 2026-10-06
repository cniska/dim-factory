import { useLayoutEffect, useRef, useState } from "react";

type Roll = "up" | "down";

const ROLL_CLASSES: Readonly<Record<Roll, { readonly enter: string; readonly leave: string }>> = {
  up: { enter: "slide-in-from-bottom-full", leave: "slide-out-to-top-full" },
  down: { enter: "slide-in-from-top-full", leave: "slide-out-to-bottom-full" },
};

function magnitude(figure: string): number {
  return Number(figure.replace(/\D/g, ""));
}

type Shown = { readonly current: string; readonly leaving: string | null; readonly roll: Roll | null };

function shown(character: string): string {
  return character === " " ? " " : character;
}

function Column({ character, roll }: { character: string; roll: Roll | null }) {
  const [state, setState] = useState<Shown>(() => ({ current: character, leaving: null, roll }));
  if (state.current !== character) setState({ current: character, leaving: state.current, roll });
  const classes = state.roll === null ? null : ROLL_CLASSES[state.roll];
  return (
    <span className="relative inline-block">
      <span
        key={`in-${state.current}`}
        className={
          classes === null
            ? "inline-block"
            : `animate-in ${classes.enter} motion-reduce:animate-none inline-block duration-300`
        }
      >
        {shown(state.current)}
      </span>
      {state.leaving !== null && classes !== null ? (
        <span
          key={`out-${state.leaving}`}
          aria-hidden="true"
          onAnimationEnd={() => setState((was) => ({ ...was, leaving: null }))}
          className={`animate-out ${classes.leave} fill-mode-forwards motion-reduce:hidden absolute top-0 left-0 duration-300`}
        >
          {shown(state.leaving)}
        </span>
      ) : null}
    </span>
  );
}

export function Digits({ value }: { value: string }) {
  const drawn = useRef<string | null>(null);
  const before = drawn.current;
  useLayoutEffect(() => {
    drawn.current = value;
  }, [value]);

  const roll: Roll | null =
    before === null || before === value ? null : magnitude(value) < magnitude(before) ? "down" : "up";

  return (
    <span className="inline-flex overflow-hidden leading-[15px] [clip-path:inset(0)] [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]">
      {value.split("").map((character, index) => (
        <Column
          // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place counted from the right, so units and decimals keep their column as the number grows
          key={value.length - index}
          character={character}
          roll={roll}
        />
      ))}
    </span>
  );
}
