export declare const SUPABASE_URL: string;
export declare function originAllowed(origin: string): boolean;
export declare function adminDb(): any;
export declare function readBody(req: any): any;
export declare function guard(req: any, res: any): boolean;
export declare function rateLimited(req: any, res: any, bucket: string, max: number): Promise<boolean>;
export declare function sendEmail(m: { to: string; subject: string; text: string }): Promise<boolean>;
