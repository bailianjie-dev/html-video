/**
 * @html-video/core — Public API surface.
 */

export * from './types/index.js';
export { HtmlVideoError } from './errors.js';
export type { ErrorCode } from './errors.js';
export { AssetStore } from './asset-store.js';
export type { AssetStoreOptions } from './asset-store.js';
export { EngineRegistry, TemplateRegistry, ProjectStore } from './registry.js';
export { ProjectOrchestrator } from './project.js';
export type {
  CreateProjectInput,
  ProjectOrchestratorDeps,
} from './project.js';
export { FileProjectPersistence } from './services/file-project-persistence.js';
export { PostgresProjectPersistence } from './services/postgres-project-persistence.js';
export {
  albumRowToProject,
  albumStatusToProjectStatus,
  projectStatusToAlbumStatus,
  projectToAlbumSettings,
} from './services/project-mapper.js';
export { LOCAL_DEV_USER_CONTEXT } from './services/user-context.js';
export type { ProjectPersistence } from './services/project-persistence.js';
export type { PostgresProjectPersistenceOptions } from './services/postgres-project-persistence.js';
export type { UserContext } from './services/user-context.js';
export type {
  DbClient,
  DbQueryResult,
  DbTransaction,
  TransactionalDbClient,
} from './db/client.js';
export * from './db/types.js';
export { AlbumRepository } from './repositories/album-repository.js';
export { AlbumPageRepository } from './repositories/album-page-repository.js';
export { AssetRepository } from './repositories/asset-repository.js';
export { AiGenerationLogRepository } from './repositories/ai-generation-log-repository.js';
export { ExportJobRepository } from './repositories/export-job-repository.js';
export {
  resolveMinimaxCredentials,
  generateTts,
  generateMusic,
} from './minimax.js';
export type { MinimaxCredentials, MinimaxAudioResult } from './minimax.js';
