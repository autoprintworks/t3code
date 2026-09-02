import type { ReactNode, Ref } from "react";

export interface ChatComposerOverlayProps {
  /**
   * A read-only thread has no composer at all, rather than a disabled one.
   *
   * Returning `null` also unmounts the measurement host, so the `ref` below
   * fires with `null` and the timeline drops the inset it was keeping for a
   * bar that is no longer there.
   */
  readonly hidden: boolean;
  /** The centred hero position a draft with no messages uses. */
  readonly hero: boolean;
  readonly ref?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}

/**
 * The chat composer's positioning shell: where the input bar sits, and whether
 * it is there at all.
 *
 * FORK DELTA (fm provider) - this component is the fork's edit. Upstream had
 * this element inline in `ChatView`; naming it is what lets the read-only case
 * be one prop instead of a conditional wrapped around 180 lines of JSX, so the
 * composer itself stays byte-identical to upstream and a future merge sees two
 * changed lines rather than a reindent of the whole block.
 *
 * `children` are still built when `hidden` is true - React elements are plain
 * objects and nothing in them runs - so the caller keeps one code path.
 */
export function ChatComposerOverlay(props: ChatComposerOverlayProps) {
  if (props.hidden) return null;

  return (
    <div
      ref={props.ref}
      data-chat-composer-overlay="true"
      className={
        props.hero
          ? "pointer-events-none absolute inset-0 z-20 flex items-center"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
      }
    >
      {props.children}
    </div>
  );
}
