import { respondFromDealState } from "./message-handler.js";

const _retryQueue = new Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>();

export function scheduleLlmRetry(
  projetoId: string,
  dealId: string,
  phone: string,
  attempts = 1,
  delayMs = 60_000
): void {
  if (attempts > 4) {
    console.warn(`[RetryQueue] Deal ${dealId}: esgotadas ${attempts} tentativas — desistindo`);
    _retryQueue.delete(dealId);
    return;
  }
  const existing = _retryQueue.get(dealId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    _retryQueue.delete(dealId);
    console.log(`[RetryQueue] Tentativa ${attempts} para deal ${dealId} (phone ${phone})`);
    try {
      await respondFromDealState(projetoId, dealId, phone);
    } catch (err: any) {
      console.warn(`[RetryQueue] Tentativa ${attempts} falhou: ${err?.message}`);
      scheduleLlmRetry(projetoId, dealId, phone, attempts + 1, Math.min(delayMs * 2, 480_000));
    }
  }, delayMs);

  _retryQueue.set(dealId, { timer, attempts });
  console.log(`[RetryQueue] Deal ${dealId}: retry em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})`);
}
