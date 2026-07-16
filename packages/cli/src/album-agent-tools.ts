import { Type, defineTool, type AgentCustomTool } from '@html-video/runtime';

export interface AlbumPageReadModel {
  index: number;
  pageNumber: number;
  summary: string;
  textFields: Record<string, string>;
  imageKeys: string[];
}

export interface AlbumImageAssetReadModel {
  assetId: string;
  filename: string;
}

export interface AlbumReadModel {
  exists: boolean;
  revision: number;
  pageCount: number;
  templateId: string | null;
  previewAvailable: boolean;
  pages: AlbumPageReadModel[];
  imageAssets: AlbumImageAssetReadModel[];
}

export interface AlbumViewState {
  activePageIndex: number | null;
  pageCount: number;
  previewRevision: number;
  clientRevision: number;
  updatedAt: string;
}

export interface AlbumReadToolDeps {
  getAlbumState: () => Promise<AlbumReadModel>;
  getViewState: () => Promise<AlbumViewState | null>;
}

export interface GenerateAlbumToolInput {
  request?: string;
  page_count?: number;
  style?: string;
  template_id?: string;
  confirmation_action_id?: string;
  confirm_overwrite?: boolean;
}

export interface AlbumGenerateToolDeps {
  executeGenerate: (
    toolCallId: string,
    input: GenerateAlbumToolInput,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export interface UpdateAlbumPageToolInput {
  request?: string;
  page_number?: number;
  expected_revision: number;
}

export interface UpdateAlbumToolInput {
  request?: string;
  expected_revision: number;
}

export interface AlbumUpdateToolDeps {
  executePageUpdate: (
    toolCallId: string,
    input: UpdateAlbumPageToolInput,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  executeAlbumUpdate: (
    toolCallId: string,
    input: UpdateAlbumToolInput,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export interface ReplaceAlbumAssetsToolInput {
  page_number: number;
  target_key: string;
  asset_id: string;
  expected_revision: number;
}

export interface AlbumAssetToolDeps {
  executeAssetReplacement: (
    toolCallId: string,
    input: ReplaceAlbumAssetsToolInput,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export function shouldRequireAlbumOverwrite(args: {
  albumExists: boolean;
  albumRevision: number;
  frameCount: number;
  currentHtml: string;
  templateHtml?: string | null;
}): boolean {
  if (!args.albumExists) return false;
  if (args.albumRevision > 0 || args.frameCount > 0) return true;
  if (!args.currentHtml.trim()) return false;
  if (args.templateHtml !== undefined && args.templateHtml !== null) {
    return args.currentHtml.trim() !== args.templateHtml.trim();
  }
  return true;
}

export function normalizeAlbumViewStateInput(args: {
  input: unknown;
  pageCount: number;
  previous: AlbumViewState | null;
  now?: string;
}): { accepted: boolean; state: AlbumViewState | null } {
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return { accepted: false, state: args.previous };
  }
  const input = args.input as Record<string, unknown>;
  const clientRevision = Number(input.clientRevision ?? input.client_revision);
  if (!Number.isSafeInteger(clientRevision) || clientRevision < 0) {
    return { accepted: false, state: args.previous };
  }
  if (args.previous && clientRevision < args.previous.clientRevision) {
    return { accepted: false, state: args.previous };
  }
  if (args.previous && clientRevision === args.previous.clientRevision) {
    return { accepted: true, state: args.previous };
  }
  const pageCount = Math.max(0, Math.floor(args.pageCount));
  const requestedIndex = input.activePageIndex ?? input.active_page_index;
  const numericIndex = requestedIndex === null ? null : Number(requestedIndex);
  const activePageIndex = numericIndex !== null
    && Number.isSafeInteger(numericIndex)
    && numericIndex >= 0
    && numericIndex < pageCount
      ? numericIndex
      : null;
  const previewRevisionRaw = Number(input.previewRevision ?? input.preview_revision ?? 0);
  const previewRevision = Number.isSafeInteger(previewRevisionRaw) && previewRevisionRaw >= 0
    ? previewRevisionRaw
    : 0;
  return {
    accepted: true,
    state: {
      activePageIndex,
      pageCount,
      previewRevision,
      clientRevision,
      updatedAt: args.now ?? new Date().toISOString(),
    },
  };
}

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(details) }],
    details,
  };
}

/** The only Phase 3 mutation tool. HTML stays behind the host callback. */
export function createAlbumGenerateTool(deps: AlbumGenerateToolDeps): AgentCustomTool {
  return defineTool({
    name: 'generate_album',
    label: 'Generate album',
    description: [
      'Generate a complete electronic album from a concrete requirement.',
      'For a new album, pass request and optional page_count/style/template_id.',
      'If the tool requests overwrite confirmation, ask the user and then call this tool again with confirmation_action_id and confirm_overwrite.',
      'Never pass HTML. The host invokes a dedicated generator and persists the validated result.',
    ].join(' '),
    promptSnippet: 'Generate or replace an electronic album through the host-managed album generator.',
    parameters: Type.Object({
      request: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: 'Concrete album requirements. Do not put HTML here.',
      })),
      page_count: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 30,
        description: 'Requested number of pages.',
      })),
      style: Type.Optional(Type.String({
        maxLength: 1_000,
        description: 'Visual direction in natural language.',
      })),
      template_id: Type.Optional(Type.String({
        maxLength: 200,
        description: 'An existing Studio template id only when already known.',
      })),
      confirmation_action_id: Type.Optional(Type.String({
        maxLength: 100,
        description: 'Opaque action id returned by an earlier confirmation_required result.',
      })),
      confirm_overwrite: Type.Optional(Type.Boolean({
        description: 'With confirmation_action_id: true confirms replacement; false cancels it.',
      })),
    }),
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      const input = params as GenerateAlbumToolInput;
      const hasConfirmation = typeof input.confirmation_action_id === 'string'
        && input.confirmation_action_id.trim().length > 0;
      if (hasConfirmation && typeof input.confirm_overwrite !== 'boolean') {
        return result({
          ok: false,
          code: 'CONFIRMATION_DECISION_REQUIRED',
          message: 'confirm_overwrite must be true or false when confirmation_action_id is supplied',
        });
      }
      if (!hasConfirmation && !input.request?.trim()) {
        return result({
          ok: false,
          code: 'INVALID_GENERATION_REQUEST',
          message: 'request is required for a new generation request',
        });
      }
      return result(await deps.executeGenerate(toolCallId, input, signal));
    },
  });
}

/** Phase 4 mutation tools. Both accept intent only; album HTML stays host-side. */
export function createAlbumUpdateTools(deps: AlbumUpdateToolDeps): AgentCustomTool[] {
  const updateAlbumPage = defineTool({
    name: 'update_album_page',
    label: 'Update album page',
    description: [
      'Modify exactly one page of the existing electronic album without replacing the whole album.',
      'Pass a one-based page_number when the user names a page; otherwise omit it to use the current Studio page.',
      'A precise single-page modification executes without confirmation.',
      'Never pass HTML. The host reads the album and current page, invokes a dedicated modifier, validates page isolation, and persists a new revision.',
    ].join(' '),
    promptSnippet: 'Modify one explicit or currently selected album page through the host-managed modifier.',
    parameters: Type.Object({
      request: Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: 'Concrete page modification requirements. Do not put HTML here.',
      }),
      expected_revision: Type.Integer({
        minimum: 0,
        description: 'Current album_revision returned by an album read tool. Never guess this value.',
      }),
      page_number: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 30,
        description: 'One-based target page. Omit only when the user refers to the current page.',
      })),
    }),
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      const input = params as UpdateAlbumPageToolInput;
      if (!input.request?.trim()) {
        return result({
          ok: false,
          code: 'INVALID_PAGE_UPDATE_REQUEST',
          message: 'request is required for a page update',
        });
      }
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
        return result({
          ok: false,
          code: 'EXPECTED_REVISION_REQUIRED',
          message: 'Read the current album state and pass its album_revision before updating.',
        });
      }
      return result(await deps.executePageUpdate(toolCallId, input, signal));
    },
  });

  const updateAlbum = defineTool({
    name: 'update_album',
    label: 'Update album',
    description: [
      'Apply a structure-preserving change across the existing electronic album, such as global styling or copy direction.',
      'This tool preserves page count and is not for regeneration, full replacement, or overwrite requests; use generate_album for those.',
      'Never pass HTML. The host invokes a dedicated modifier, validates the complete result, and persists a new revision.',
    ].join(' '),
    promptSnippet: 'Apply a non-destructive, whole-album update while preserving its page structure.',
    parameters: Type.Object({
      request: Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: 'Concrete whole-album modification requirements. Do not put HTML here.',
      }),
      expected_revision: Type.Integer({
        minimum: 0,
        description: 'Current album_revision returned by an album read tool. Never guess this value.',
      }),
    }),
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      const input = params as UpdateAlbumToolInput;
      if (!input.request?.trim()) {
        return result({
          ok: false,
          code: 'INVALID_ALBUM_UPDATE_REQUEST',
          message: 'request is required for an album update',
        });
      }
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
        return result({
          ok: false,
          code: 'EXPECTED_REVISION_REQUIRED',
          message: 'Read the current album state and pass its album_revision before updating.',
        });
      }
      return result(await deps.executeAlbumUpdate(toolCallId, input, signal));
    },
  });

  return [updateAlbumPage, updateAlbum];
}

/** Replace one explicit image slot with one explicit project-owned image asset. */
export function createAlbumAssetTools(deps: AlbumAssetToolDeps): AgentCustomTool[] {
  const replaceAlbumAssets = defineTool({
    name: 'replace_album_assets',
    label: 'Replace album asset',
    description: [
      'Replace exactly one data-hv-image slot on one album page with one image asset already owned by the current project.',
      'All four inputs are required and must come from live read state or explicit attachment metadata.',
      'Never guess among multiple assets or image slots. Ask the user to choose when asset_id or target_key is ambiguous.',
      'Never pass HTML, a local path, a browser URL, or any external URL. The host resolves asset_id to its internal project URL.',
    ].join(' '),
    promptSnippet: 'Replace one explicit album image key with one explicit project-owned image asset.',
    parameters: Type.Object({
      page_number: Type.Integer({
        minimum: 1,
        maximum: 30,
        description: 'One-based target page returned by an album read tool.',
      }),
      target_key: Type.String({
        minLength: 1,
        maxLength: 200,
        description: 'Exact data-hv-image key returned by get_album_page. Never infer a slot by position.',
      }),
      asset_id: Type.String({
        minLength: 1,
        maxLength: 200,
        description: 'Exact project image asset id. Do not pass a path, URL, filename, or HTML.',
      }),
      expected_revision: Type.Integer({
        minimum: 0,
        description: 'Current album_revision returned by an album read tool. Never guess this value.',
      }),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      const input = params as ReplaceAlbumAssetsToolInput & Record<string, unknown>;
      const allowed = new Set(['page_number', 'target_key', 'asset_id', 'expected_revision']);
      const unsupported = Object.keys(input).find((key) => !allowed.has(key));
      if (unsupported) {
        return result({
          ok: false,
          code: 'UNSUPPORTED_ASSET_INPUT_FIELD',
          field: unsupported,
          album_changed: false,
        });
      }
      if (!Number.isSafeInteger(input.page_number) || input.page_number < 1) {
        return result({ ok: false, code: 'PAGE_NUMBER_REQUIRED', album_changed: false });
      }
      const targetKey = input.target_key?.trim() ?? '';
      const assetId = input.asset_id?.trim() ?? '';
      if (!targetKey) {
        return result({ ok: false, code: 'TARGET_KEY_REQUIRED', album_changed: false });
      }
      if (!assetId) {
        return result({ ok: false, code: 'ASSET_ID_REQUIRED', album_changed: false });
      }
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(assetId)) {
        return result({ ok: false, code: 'ASSET_ID_MUST_NOT_BE_PATH_OR_URL', album_changed: false });
      }
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
        return result({
          ok: false,
          code: 'EXPECTED_REVISION_REQUIRED',
          message: 'Read the current album state and pass its album_revision before replacing an asset.',
          album_changed: false,
        });
      }
      return result(await deps.executeAssetReplacement(toolCallId, {
        page_number: input.page_number,
        target_key: targetKey,
        asset_id: assetId,
        expected_revision: input.expected_revision,
      }, signal));
    },
  });

  return [replaceAlbumAssets];
}

export function createAlbumReadTools(deps: AlbumReadToolDeps): AgentCustomTool[] {
  const getAlbumState = defineTool({
    name: 'get_album_state',
    label: 'Get album state',
    description: 'Read whether the current project has an album, its page count, template, preview availability, and page summaries. Use this for factual questions about the album.',
    promptSnippet: 'Read the current album state and page summaries.',
    parameters: Type.Object({}),
    executionMode: 'parallel',
    execute: async () => {
      const album = await deps.getAlbumState();
      return result({
        ok: true,
        exists: album.exists,
        album_revision: album.revision,
        page_count: album.pageCount,
        template_id: album.templateId,
        preview_available: album.previewAvailable,
        pages: album.pages.map((page) => ({
          page_number: page.pageNumber,
          summary: page.summary,
          image_keys: page.imageKeys,
        })),
        image_assets: album.imageAssets.map((asset) => ({
          asset_id: asset.assetId,
          filename: asset.filename,
        })),
      });
    },
  });

  const getCurrentPage = defineTool({
    name: 'get_current_page',
    label: 'Get current page',
    description: 'Read the page currently selected in the Studio UI. Always use this tool for questions such as "which page am I on?" Never infer the current page from chat history.',
    promptSnippet: 'Read the page currently selected in Studio.',
    parameters: Type.Object({}),
    executionMode: 'parallel',
    execute: async () => {
      const [album, view] = await Promise.all([deps.getAlbumState(), deps.getViewState()]);
      if (!album.exists) {
        return result({ ok: true, known: false, reason: 'NO_ALBUM', album_revision: album.revision });
      }
      if (!view || view.activePageIndex === null) {
        return result({ ok: true, known: false, reason: 'CURRENT_PAGE_UNKNOWN', album_revision: album.revision });
      }
      const page = album.pages[view.activePageIndex];
      if (!page) {
        return result({ ok: true, known: false, reason: 'CURRENT_PAGE_OUT_OF_RANGE', album_revision: album.revision });
      }
      return result({
        ok: true,
        known: true,
        page_index: page.index,
        page_number: page.pageNumber,
        page_count: album.pageCount,
        album_revision: album.revision,
        summary: page.summary,
        image_keys: page.imageKeys,
        view_updated_at: view.updatedAt,
      });
    },
  });

  const getAlbumPage = defineTool({
    name: 'get_album_page',
    label: 'Get album page',
    description: 'Read a specific album page. Pass a one-based page_number, or omit it to read the current Studio page. Returns the page summary and editable text fields.',
    promptSnippet: 'Read one album page and its editable text.',
    parameters: Type.Object({
      page_number: Type.Optional(Type.Integer({ minimum: 1, description: 'One-based album page number. Omit to use the current Studio page.' })),
    }),
    executionMode: 'parallel',
    execute: async (_toolCallId, params) => {
      const album = await deps.getAlbumState();
      if (!album.exists) return result({ ok: false, code: 'NO_ALBUM', album_revision: album.revision });
      let pageIndex: number | null = params.page_number === undefined
        ? null
        : params.page_number - 1;
      if (pageIndex === null) {
        const view = await deps.getViewState();
        pageIndex = view?.activePageIndex ?? null;
      }
      if (pageIndex === null) {
        return result({ ok: false, code: 'CURRENT_PAGE_UNKNOWN', album_revision: album.revision });
      }
      const page = album.pages[pageIndex];
      if (!page) {
        return result({
          ok: false,
          code: 'PAGE_OUT_OF_RANGE',
          requested_page_number: pageIndex + 1,
          page_count: album.pageCount,
          album_revision: album.revision,
        });
      }
      return result({
        ok: true,
        page_index: page.index,
        page_number: page.pageNumber,
        page_count: album.pageCount,
        album_revision: album.revision,
        summary: page.summary,
        text_fields: page.textFields,
        image_keys: page.imageKeys,
      });
    },
  });

  return [getAlbumState, getCurrentPage, getAlbumPage];
}
