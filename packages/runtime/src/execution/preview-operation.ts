/**
 * Controls one frozen preview without exposing receivers or native effects.
 * seek uses milliseconds from the preview start; negative values clamp to zero
 * and non-finite values are ignored. Backward seeking is supported.
 * end restores accepted application presentation and external CSS. Both methods
 * become no-ops after termination, supersession, rebinding, or Runtime disposal.
 * Browser/restore failures propagate to the caller.
 */
export interface PreviewOperation {
  seek(milliseconds: number): void
  end(): void
}
