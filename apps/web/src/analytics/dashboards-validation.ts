import { parseName, parseUuid } from "../lib/input";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	encodeDashboardFilters,
	encodeTileOverrides,
	MAX_DASHBOARD_FILTERS_LENGTH,
} from "./dashboard-filters";
import {
	type AddTilesInput,
	type CopyTileInput,
	type DashboardReference,
	type DuplicateTileInput,
	GRID_COLUMNS,
	type LayoutInput,
	MAX_DASHBOARD_DESCRIPTION,
	MAX_DASHBOARD_TILES,
	type RemoveTileInput,
	type SaveDashboardInput,
	TILE_COLORS,
	TILE_HEIGHTS,
	TILE_WIDTHS,
	type TileColor,
	type TileHeight,
	type TileOptions,
	type TileReference,
	type TileWidth,
	type UpdateTileInput,
} from "./dashboards";

function record(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InputError("INVALID_QUERY", "Invalid request");
	return value as Record<string, unknown>;
}

export function parseDashboardReference(value: unknown): DashboardReference {
	return {
		...parseProjectReference(value),
		dashboardId: parseUuid(record(value).dashboardId, "dashboard identifier"),
	};
}

/** A project and the dashboard it opens on, or null for the fleet overview. */
export function parseProjectHome(value: unknown) {
	const input = record(value);
	return {
		...parseProjectReference(value),
		dashboardId:
			input.dashboardId === null
				? null
				: parseUuid(input.dashboardId, "dashboard identifier"),
	};
}

/** Overrides' JSON text, normalized. */
function parseFilters(value: unknown) {
	if (typeof value !== "string" || value.length > MAX_DASHBOARD_FILTERS_LENGTH)
		throw new InputError("INVALID_QUERY", "Invalid dashboard filters");
	try {
		return encodeDashboardFilters(JSON.parse(value));
	} catch (error) {
		if (error instanceof InputError) throw error;
		throw new InputError("INVALID_QUERY", "Invalid dashboard filters");
	}
}

export function parseSaveDashboard(value: unknown): SaveDashboardInput {
	const input = record(value);
	const description =
		typeof input.description === "string" ? input.description.trim() : null;
	if (
		input.description !== undefined &&
		(description === null || description.length > MAX_DASHBOARD_DESCRIPTION)
	)
		throw new InputError("INVALID_QUERY", "Invalid dashboard description");
	return {
		...parseDashboardReference(value),
		name: parseName(input.name),
		...(description === null ? {} : { description }),
		...(input.filters === undefined
			? {}
			: { filters: parseFilters(input.filters) }),
	};
}

export function parseAddTiles(value: unknown): AddTilesInput {
	const ids = record(value).insightIds;
	if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DASHBOARD_TILES)
		throw new InputError("INVALID_QUERY", "Invalid insight identifiers");
	return {
		...parseDashboardReference(value),
		insightIds: [
			...new Set(ids.map((id) => parseUuid(id, "insight identifier"))),
		],
	};
}

export function parseLayout(value: unknown): LayoutInput {
	const tiles = record(value).tiles;
	if (!Array.isArray(tiles) || tiles.length > MAX_DASHBOARD_TILES)
		throw new InputError("INVALID_QUERY", "Invalid layout");
	const parsed = tiles.map((tile) => {
		const entry = record(tile);
		const column = entry.column ?? null;
		if (
			!TILE_WIDTHS.includes(entry.width as TileWidth) ||
			!TILE_HEIGHTS.includes(entry.height as TileHeight) ||
			(column !== null &&
				(!Number.isInteger(column) ||
					(column as number) < 1 ||
					(column as number) + (entry.width as number) - 1 > GRID_COLUMNS))
		)
			throw new InputError("INVALID_QUERY", "Invalid tile size");
		return {
			id: parseUuid(entry.id, "tile identifier"),
			width: entry.width as TileWidth,
			height: entry.height as TileHeight,
			column: column as number | null,
		};
	});
	if (new Set(parsed.map((tile) => tile.id)).size !== parsed.length)
		throw new InputError("INVALID_QUERY", "Invalid layout");
	return { ...parseDashboardReference(value), tiles: parsed };
}

export function parseRemoveTile(value: unknown): RemoveTileInput {
	return {
		...parseDashboardReference(value),
		tileId: parseUuid(record(value).tileId, "tile identifier"),
	};
}

export function parseTileReference(value: unknown): TileReference {
	return {
		...parseDashboardReference(value),
		tileId: parseUuid(record(value).tileId, "tile identifier"),
	};
}

function parseTileOptions(value: unknown): TileOptions {
	const input = record(value);
	if (
		Object.keys(input).some(
			(key) => key !== "hideDescription" && key !== "color",
		) ||
		(input.hideDescription !== undefined &&
			typeof input.hideDescription !== "boolean") ||
		(input.color !== undefined &&
			!TILE_COLORS.includes(input.color as TileColor))
	)
		throw new InputError("INVALID_QUERY", "Invalid tile options");
	return {
		...(input.hideDescription ? { hideDescription: true } : {}),
		...(input.color ? { color: input.color as TileColor } : {}),
	};
}

export function parseUpdateTile(value: unknown): UpdateTileInput {
	const input = record(value);
	let overrides: string | undefined;
	if (input.overrides !== undefined) {
		if (
			typeof input.overrides !== "string" ||
			input.overrides.length > MAX_DASHBOARD_FILTERS_LENGTH
		)
			throw new InputError("INVALID_QUERY", "Invalid tile overrides");
		try {
			overrides = encodeTileOverrides(JSON.parse(input.overrides));
		} catch (error) {
			if (error instanceof InputError) throw error;
			throw new InputError("INVALID_QUERY", "Invalid tile overrides");
		}
	}
	return {
		...parseTileReference(value),
		...(overrides === undefined ? {} : { overrides }),
		...(input.options === undefined
			? {}
			: { options: parseTileOptions(input.options) }),
	};
}

export function parseCopyTile(value: unknown): CopyTileInput {
	const input = record(value);
	if (typeof input.move !== "boolean")
		throw new InputError("INVALID_QUERY", "Invalid request");
	const reference = parseTileReference(value);
	const targetDashboardId = parseUuid(
		input.targetDashboardId,
		"dashboard identifier",
	);
	if (targetDashboardId === reference.dashboardId)
		throw new InputError("INVALID_QUERY", "Choose another dashboard");
	return { ...reference, targetDashboardId, move: input.move };
}

export function parseDuplicateTile(value: unknown): DuplicateTileInput {
	return {
		...parseTileReference(value),
		name: parseName(record(value).name),
	};
}
