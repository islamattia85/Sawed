import type { z } from 'zod';
export declare const QuoteSchema: z.ZodType<any>;
export declare const SYSTEM_PROMPT: string;
export declare const MAX_BYTES: number;
export declare const MEDIA_TYPES: string[];
export declare function checkUpload(body: unknown): string | null;
export declare function reconcile<T extends Record<string, any>>(q: T): T & { warnings: string[] };
