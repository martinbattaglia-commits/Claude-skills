"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

/**
 * A money input that optionally carries a left-edge currency echo. When `echo`
 * is present (a non-THB row) the input sits in the bordered `.amt-field` box after the
 * echo, so the unit is unambiguous; when it's null (THB) it renders as the bare field it
 * always was — THB rows stay visually unchanged. Shared by every money box (avg cost,
 * current price, price, fee, cash amount) so they wrap identically.
 */
export function MoneyInput({
  echo,
  className,
  ...props
}: { echo: ReactNode } & InputHTMLAttributes<HTMLInputElement> & {
    // Host <input> data-* attrs (data-optional / data-estimated) aren't in
    // InputHTMLAttributes for a custom component — declare them so callers can pass them.
    [key: `data-${string}`]: string | undefined;
  }) {
  if (echo) {
    return (
      <div className="amt-field">
        {echo}
        <input className={`amt-field__input${className ? ` ${className}` : ""}`} {...props} />
      </div>
    );
  }
  return <input className={className} {...props} />;
}
