export interface AdminThemePresetInterface {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly isShared: boolean;
  readonly isOwn: boolean;
  readonly themeData: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}
