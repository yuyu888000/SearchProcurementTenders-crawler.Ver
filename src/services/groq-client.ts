import axios from 'axios';
import { execFileSync } from 'node:child_process';

/**
 * Groq（OpenAI 相容 API）呼叫。只給 rank_by_topic／expand_keywords 用，其他工具不依賴它。
 *
 * 金鑰只從環境變數 GROQ_API_KEY 讀，永遠不寫進程式或輸出。
 * 免費帳號 openai/gpt-oss-120b 實測每分鐘 8,000 token（2026-09-17），
 * 2,031 筆標案名稱打分數實際回應只花 148 秒，其餘 850 秒都在等 429——所以一定要照 retry-after 等。
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

export class GroqError extends Error {
  constructor(message: string, readonly kind: 'no-key' | 'auth' | 'deadline' | 'http') {
    super(message);
  }
}

let registryKey: string | null | undefined;

/**
 * Claude Desktop 啟動 MCP 時只傳一小部分環境變數，使用者層級的 GROQ_API_KEY 進不來（2026-09-17 實測）。
 * Windows 上退而讀 HKCU\Environment，金鑰就不必以明文寫進 MCP 設定檔。值只放記憶體，不輸出。
 */
function groqKey(): string | undefined {
  const fromEnv = process.env.GROQ_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== 'win32') return undefined;
  if (registryKey === undefined) {
    try {
      const out = execFileSync('reg', ['query', String.raw`HKCU\Environment`, '/v', 'GROQ_API_KEY'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      registryKey = out.match(/GROQ_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/)?.[1] ?? null;
    } catch {
      registryKey = null;
    }
  }
  return registryKey ?? undefined;
}

export function hasGroqKey(): boolean {
  return Boolean(groqKey());
}

export const NO_KEY_MESSAGE = '找不到 GROQ_API_KEY，這支工具需要 Groq 金鑰（其他工具不受影響）。'
  + '已找過行程環境變數與 Windows 使用者環境變數（HKCU\\Environment）。請用 setx GROQ_API_KEY 設定後完全關閉再重開 Claude，'
  + '或在 MCP 設定檔這個 server 的 env 區塊加上它。';

export interface GroqUsage { calls: number; promptTokens: number; completionTokens: number; waitedMs: number }

export function newUsage(): GroqUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, waitedMs: 0 };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 送一次 prompt，回傳文字。429 依 retry-after 等待；超過 deadline（epoch ms）就丟 deadline 錯誤。 */
export async function groqChat(prompt: string, usage: GroqUsage, opts: { maxTokens?: number; deadline?: number } = {}): Promise<string> {
  const key = groqKey();
  if (!key) throw new GroqError(NO_KEY_MESSAGE, 'no-key');

  for (let attempt = 1; ; attempt++) {
    const r = await axios.post(ENDPOINT, {
      model: GROQ_MODEL,
      temperature: 0,
      reasoning_effort: 'low',
      max_tokens: opts.maxTokens ?? 3000,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 120_000,
      validateStatus: () => true,
    }).catch((e: any) => ({ status: 0, data: { error: e.message }, headers: {} as Record<string, string> }));

    if (r.status === 200) {
      usage.calls++;
      usage.promptTokens += r.data?.usage?.prompt_tokens ?? 0;
      usage.completionTokens += r.data?.usage?.completion_tokens ?? 0;
      return String(r.data?.choices?.[0]?.message?.content ?? '');
    }
    if (r.status === 401 || r.status === 403) {
      throw new GroqError(`Groq 拒絕金鑰（HTTP ${r.status}），請確認 GROQ_API_KEY 是否有效。`, 'auth');
    }
    if (r.status === 429) {
      const wait = Math.ceil(parseFloat(String((r.headers as any)['retry-after'] ?? '10')) * 1000) + 500;
      if (opts.deadline && Date.now() + wait > opts.deadline) {
        throw new GroqError('已達本次執行時間上限', 'deadline');
      }
      usage.waitedMs += wait;
      await sleep(wait);
      continue;
    }
    if (attempt >= 4) {
      throw new GroqError(`Groq 呼叫失敗（HTTP ${r.status}）：${JSON.stringify(r.data).slice(0, 200)}`, 'http');
    }
    await sleep(3000 * attempt);
  }
}

/** 從模型回覆取出第一個 [ 到最後一個 ] 之間的 JSON 陣列；解析失敗回 null */
export function extractJsonArray(text: string): unknown[] | null {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
