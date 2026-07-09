import type { AlbumRow, AssetRow, CreateAssetInput } from '../db/types.js';
import { HtmlVideoError } from '../errors.js';
import { AlbumRepository } from '../repositories/album-repository.js';
import { AssetRepository } from '../repositories/asset-repository.js';
import type { UserContext } from './user-context.js';

type AlbumLookup = Pick<AlbumRepository, 'findById' | 'findBySourceProjectId'>;
type AssetAccess = Pick<AssetRepository, 'create' | 'findById' | 'listByAlbum' | 'softDelete'>;

export type CreateProjectAssetInput = Omit<
  CreateAssetInput,
  'user_id' | 'album_id' | 'created_by' | 'updated_by'
>;

export interface PostgresAssetPersistenceOptions {
  getUserContext: () => Readonly<UserContext>;
  albums: AlbumLookup;
  assets: AssetAccess;
}

/**
 * Keeps project-scoped asset access tied to the current request user.
 */
export class PostgresAssetPersistence {
  constructor(private readonly opts: PostgresAssetPersistenceOptions) {}

  async createForProject(
    projectId: string,
    input: CreateProjectAssetInput,
  ): Promise<AssetRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    return this.opts.assets.create({
      ...input,
      user_id: user.userId,
      album_id: album.id,
      created_by: user.actorId,
      updated_by: user.actorId,
    });
  }

  async listForProject(
    projectId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<AssetRow[]> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    return this.opts.assets.listByAlbum(user.userId, album.id, opts);
  }

  async softDeleteForProject(
    projectId: string,
    assetId: string,
    opts: { allowMissingDatabaseRow?: boolean } = {},
  ): Promise<AssetRow | null> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const asset = await this.opts.assets.findById(user.userId, assetId);
    if (!asset || asset.album_id !== album.id || asset.status === 'deleted') {
      if (opts.allowMissingDatabaseRow && !asset) return null;
      throw new HtmlVideoError('asset-not-found', `Asset ${assetId} not found`);
    }
    const deleted = await this.opts.assets.softDelete(user.userId, assetId, user.actorId);
    if (!deleted) {
      throw new HtmlVideoError('asset-not-found', `Asset ${assetId} not found`);
    }
    return deleted;
  }

  private async requireAlbum(
    projectId: string,
    user: Readonly<UserContext>,
  ): Promise<AlbumRow> {
    const bySourceProjectId = await this.opts.albums.findBySourceProjectId(
      user.userId,
      projectId,
    );
    const album = bySourceProjectId
      ?? (isUuid(projectId)
        ? await this.opts.albums.findById(user.userId, projectId)
        : null);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${projectId} not found`);
    }
    return album;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
