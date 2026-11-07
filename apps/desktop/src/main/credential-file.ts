import { chmod, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ConnectionSummary, ProviderId, StoredCredential, CredentialStatus } from "@ai-book-studio/core/providers/types";
import type { CredentialVault } from "@ai-book-studio/core/providers/credentials";
import { writeFileAtomic } from "./library/atomic";

interface StoredRecord {
  id: string;
  provider: ProviderId;
  label: string;
  kind: StoredCredential["kind"];
  createdAt: string;
  lastUsedAt?: string;
  planUsable?: boolean;
  secretCipher: string;
  refreshCipher?: string;
  metadata?: Record<string, string>;
}

interface VaultFile {
  version: 1;
  records: StoredRecord[];
}

export interface Cipher {
  available(): boolean | Promise<boolean>;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/**
 * The cipher an isolated test run uses. A run started with both `STUDIO_TEST=1` and
 * `STUDIO_NO_KEYCHAIN=1` refuses protected storage without asking the operating system, so a hidden
 * check never reaches the author's keychain. It is a refusal and not a fallback: nothing is
 * written, and a run without both flags keeps the cipher it was given.
 */
export function selectTestCipher(cipher: Cipher, env: Readonly<Record<string, string | undefined>>): Cipher {
  if (env.STUDIO_TEST !== "1" || env.STUDIO_NO_KEYCHAIN !== "1") return cipher;
  const refuse = (): never => {
    throw new Error("Protected storage is switched off for this isolated test run.");
  };
  return { available: () => false, encrypt: refuse, decrypt: refuse };
}

/**
 * Credential storage without a dependency on Electron, so it can be tested directly under Bun.
 * The desktop wrapper supplies the operating system's cipher; the file format is identical either
 * way and never contains a plaintext secret.
 */
export class FileCredentialVault implements CredentialVault {
  private cache: VaultFile | null = null;

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher
  ) {}

  async isAvailable(): Promise<boolean> {
    return await this.cipher.available();
  }

  async status(): Promise<Omit<CredentialStatus, "connections">> {
    return { available: await this.cipher.available(), backend: "Protected storage", detail: "" };
  }

  /**
   * Explicit round-trip probe for the keychain check control. This is the only vault call that
   * touches a secret-shaped value, so views must not call it on open: when the operating
   * system wants the author's confirmation, this call waits for them.
   */
  async check(): Promise<Omit<CredentialStatus, "connections">> {
    if (!(await this.cipher.available())) {
      return { available: false, backend: "Protected storage", detail: "Protected storage is unavailable." };
    }
    try {
      const probe = `credential-probe-${Date.now()}`;
      if (this.cipher.decrypt(this.cipher.encrypt(probe)) !== probe) throw new Error("probe mismatch");
      return { available: true, backend: "Protected storage", detail: "" };
    } catch {
      return {
        available: false,
        backend: "Protected storage",
        detail: "Protected storage refused the check. Unlock the system keyring, then check again."
      };
    }
  }

  /**
   * Owner-only permissions are part of the promise, not just the write path. A file restored from a
   * backup or copied between machines can arrive world-readable; check it at startup and correct it.
   * Windows does not expose POSIX modes, so a failed chmod is reported rather than treated as fatal.
   */
  async repairPermissions(): Promise<"owner-only" | "corrected" | "unavailable"> {
    try {
      const info = await stat(this.path);
      if ((info.mode & 0o077) === 0) return "owner-only";
      await chmod(this.path, 0o600);
      return "corrected";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "owner-only";
      try {
        await chmod(this.path, 0o600);
        return "corrected";
      } catch {
        return "unavailable";
      }
    }
  }

  async list(): Promise<ConnectionSummary[]> {
    const file = await this.load();
    return file.records.map(({ secretCipher: _s, refreshCipher: _r, metadata: _m, ...summary }) => summary);
  }

  async get(id: string): Promise<StoredCredential | null> {
    const record = (await this.load()).records.find((item) => item.id === id);
    if (!record) return null;
    const secret = this.decrypt(record.secretCipher);
    const refreshToken = record.refreshCipher ? this.decrypt(record.refreshCipher) : undefined;
    return {
      id: record.id,
      provider: record.provider,
      label: record.label,
      kind: record.kind,
      createdAt: record.createdAt,
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
      ...(record.planUsable !== undefined ? { planUsable: record.planUsable } : {}),
      secret,
      ...(refreshToken ? { refreshToken } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {})
    };
  }

  async set(credential: StoredCredential): Promise<void> {
    await this.requireEncryption();
    const file = await this.load();
    const record: StoredRecord = {
      id: credential.id,
      provider: credential.provider,
      label: credential.label,
      kind: credential.kind,
      createdAt: credential.createdAt,
      ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
      ...(credential.planUsable !== undefined ? { planUsable: credential.planUsable } : {}),
      secretCipher: this.cipher.encrypt(credential.secret),
      ...(credential.refreshToken ? { refreshCipher: this.cipher.encrypt(credential.refreshToken) } : {}),
      ...(credential.metadata ? { metadata: credential.metadata } : {})
    };
    const records = file.records.filter((item) => item.id !== credential.id);
    records.push(record);
    await this.persist({ version: 1, records });
  }

  async remove(id: string): Promise<void> {
    const file = await this.load();
    const records = file.records.filter((item) => item.id !== id);
    if (records.length === file.records.length) return;
    await this.persist({ version: 1, records });
  }

  async touch(id: string, at: string = new Date().toISOString()): Promise<void> {
    const file = await this.load();
    const records = file.records.map((item) => (item.id === id ? { ...item, lastUsedAt: at } : item));
    await this.persist({ version: 1, records });
  }

  private async load(): Promise<VaultFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<VaultFile>;
      this.cache = { version: 1, records: Array.isArray(parsed.records) ? (parsed.records as StoredRecord[]) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[credentials] Could not read the credential file:", (error as Error).message);
      }
      this.cache = { version: 1, records: [] };
    }
    return this.cache;
  }

  private async persist(file: VaultFile): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    this.cache = file;
    try {
      await chmod(this.path, 0o600);
    } catch {
      // Windows does not use POSIX modes; the file still lives in the user's own profile.
    }
  }

  private decrypt(value: string): string {
    try {
      return this.cipher.decrypt(value);
    } catch {
      throw new Error("This connection could not be read. Remove it and connect again.");
    }
  }

  private async requireEncryption(): Promise<void> {
    if (await this.cipher.available()) return;
    throw new Error(
      "This computer's protected storage is not available, so the key was not saved. Unlock your keychain or keyring and try again."
    );
  }
}

export function newConnectionId(): string {
  return `conn_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}
