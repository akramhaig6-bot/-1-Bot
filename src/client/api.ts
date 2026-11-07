import type { ApiErrorBody, BotConfig, BotPatch, MediaType } from '@shared/types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError('تعذر الوصول إلى الخادم. تحقق من الاتصال ثم أعد المحاولة.', 0);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json() as unknown
    : null;
  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiError(body?.error || 'لم تنجح العملية. أعد المحاولة.', response.status);
  }
  return payload as T;
}

export const api = {
  async listBots(): Promise<BotConfig[]> {
    const result = await request<{ bots: BotConfig[] }>('/api/bots');
    return result.bots;
  },

  async createBot(): Promise<BotConfig> {
    const result = await request<{ bot: BotConfig }>('/api/bots', { method: 'POST' });
    return result.bot;
  },

  async getBot(id: string): Promise<BotConfig> {
    const result = await request<{ bot: BotConfig }>(`/api/bots/${encodeURIComponent(id)}`);
    return result.bot;
  },

  async updateBot(id: string, patch: BotPatch): Promise<BotConfig> {
    const result = await request<{ bot: BotConfig }>(`/api/bots/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return result.bot;
  },

  async connectBot(id: string, token: string): Promise<BotConfig> {
    const result = await request<{ bot: BotConfig }>(`/api/bots/${encodeURIComponent(id)}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return result.bot;
  },

  async uploadMedia(id: string, buttonId: string, type: MediaType, file: File): Promise<BotConfig> {
    const form = new FormData();
    form.append('buttonId', buttonId);
    form.append('type', type);
    form.append('file', file);
    const result = await request<{ bot: BotConfig }>(`/api/bots/${encodeURIComponent(id)}/media`, {
      method: 'POST',
      body: form,
    });
    return result.bot;
  },

  async deleteMedia(botId: string, mediaId: string): Promise<BotConfig> {
    const result = await request<{ bot: BotConfig }>(
      `/api/bots/${encodeURIComponent(botId)}/media/${encodeURIComponent(mediaId)}`,
      { method: 'DELETE' },
    );
    return result.bot;
  },
};
