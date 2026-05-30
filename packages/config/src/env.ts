import { config as loadDotenv } from 'dotenv';
import { z, type ZodError, type ZodTypeAny, type infer as ZodInfer } from 'zod';

/**
 * Universal env fields every WhalePod service should validate.
 * Apps extend this with their own service-specific schema.
 */
export const commonEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().min(1),
});

export type CommonEnv = ZodInfer<typeof commonEnv>;

interface ParseEnvOptions {
  /**
   * Path(s) to .env file(s) to preload before validation. Only honored when
   * NODE_ENV !== 'production'. Production must receive env via the platform.
   */
  dotenvPaths?: readonly string[];
  /** Custom source. Defaults to process.env. */
  source?: NodeJS.ProcessEnv;
}

/**
 * Parse and validate environment variables against a zod schema.
 * Fails fast with a human-readable error if validation fails. Throwing at
 * module-init prevents partially-configured services from starting.
 */
export function parseEnv<S extends ZodTypeAny>(
  schema: S,
  options: ParseEnvOptions = {},
): ZodInfer<S> {
  const source = options.source ?? process.env;
  const nodeEnv = source['NODE_ENV'] ?? 'development';

  if (nodeEnv !== 'production' && options.dotenvPaths) {
    for (const path of options.dotenvPaths) {
      loadDotenv({ path, override: false });
    }
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- zod's safeParse.data is typed `any` under generics; the schema-typed cast is sound here.
  return result.data as ZodInfer<S>;
}

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: ZodError['issues'];

  constructor(zodError: ZodError) {
    const lines = zodError.issues.map((issue) => {
      const path = issue.path.join('.') || '<root>';
      return `  - ${path}: ${issue.message}`;
    });
    super(`Invalid environment configuration:\n${lines.join('\n')}`);
    this.issues = zodError.issues;
  }
}
