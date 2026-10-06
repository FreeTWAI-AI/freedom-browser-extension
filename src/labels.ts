import type { PublicPhase } from './pairing-client.ts';

export function phaseLabel(phase: PublicPhase): string {
  switch (phase) {
    case 'disconnected':
      return '未連接';
    case 'waiting':
      return '等待你在自由工坊確認';
    case 'connected':
      return '已連接';
    case 'revoked':
      return '已撤銷';
    case 'expired':
      return '已過期';
    case 'reconnect':
      return '需要重新連接';
    default: {
      const neverPhase: never = phase;
      return neverPhase;
    }
  }
}

export function reasonHint(phase: PublicPhase, reason: string | null): string | null {
  if (phase === 'reconnect' && reason === 'denied') return '這次配對沒有通過。';
  if (phase === 'reconnect') return '這次交換結果不確定，請重新連接。';
  if (phase === 'revoked') return '自由工坊已撤銷這次連接。';
  if (phase === 'expired') return '確認碼已過期。';
  if (phase === 'connected') return '模型金鑰留在自由工坊，這個擴充功能不保存供應商金鑰。';
  return null;
}
