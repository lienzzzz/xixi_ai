/**
 * `@xixi/brain-dsh` — everything DSH-specific that is not the adapter interface:
 * the CLI transport and the profile assets (`profile/`) installed into a
 * project-local DSH home by `scripts/install-dsh-profile.ts`.
 */
export {
  CliDshTransport,
  parseDshJsonLines,
  resolveDshBinJs,
  type CliDshTransportOptions,
  type DshTurnDiagnostics,
  type ParsedDshOutput,
} from './transport.ts';
