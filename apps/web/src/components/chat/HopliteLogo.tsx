import { cn } from "~/lib/utils";
import hopliteLogo from "./logos/hoplite.png";

export function HopliteLogo({ className }: { readonly className?: string }) {
  return (
    <img alt="" aria-hidden className={cn("size-5 object-contain", className)} src={hopliteLogo} />
  );
}
