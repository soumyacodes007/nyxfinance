import { randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export const nowIso = (): string => new Date().toISOString();

export const expiresIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
