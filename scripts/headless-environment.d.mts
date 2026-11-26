export declare function headlessEnvironment(source: Record<string, string | undefined>): Record<string, string>;
export declare function headlessDesktopEnvironment(
  source: Record<string, string | undefined>,
  profile: string,
  vault?: "refuse" | "memory"
): Record<string, string>;
export declare function mockKeychainArgs(platform?: NodeJS.Platform): string[];
