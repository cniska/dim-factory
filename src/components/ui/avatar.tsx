import type { ImgHTMLAttributes } from "react";

export function Avatar({ className = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return <img className={`ui-avatar ${className}`.trim()} alt="" {...props} />;
}
