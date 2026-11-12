export interface TransportLayer {
  torFetch(
    url: string,
    userAgent: string,
    opts?: {
      method?: "GET" | "POST";
      body?: string;
      socksAuth?: { user: string; pass: string };
    },
  ): Promise<{ status: number; body: string }>;
  isNative(): Promise<boolean>;
  purgeCookies?(): Promise<void>;
}

export type TransportFactory = () => TransportLayer;
