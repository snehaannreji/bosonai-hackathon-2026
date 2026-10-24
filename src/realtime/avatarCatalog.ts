/** Both presets and account-owned avatars come from Boson's GET /v1/avatars.
 * Avatar registration is deliberately outside this integration. */
import { STUDENTS, type StudentSettings } from "../state/student";
export interface AvatarOption { id: string; name: string; isPublic: boolean }
export interface AvatarCatalog {
  // Retain the existing endpoint/field name for clients; includes owned avatars too.
  presets: AvatarOption[];
  defaultAvatarId: string;
  warning: string | null;
  studentAvatarIds?: Partial<Record<StudentSettings["id"], string>>;
}

export function parseAvatarCatalog(body: unknown): AvatarOption[] {
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Boson returned an invalid avatar catalog.");
  }
  const seen = new Set<string>();
  return body.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("avatar_id" in item) || typeof item.avatar_id !== "string") return [];
    const id = item.avatar_id.trim();
    if (!id || id.length > 256 || seen.has(id) || !("is_public" in item) || typeof item.is_public !== "boolean") return [];
    seen.add(id);
    return [{ id, name: "name" in item && typeof item.name === "string" && item.name.trim() ? item.name.trim() : id, isPublic: item.is_public }];
  });
}

export function configureAvatarCatalog(avatars: AvatarOption[], configuredId?: string, studentAvatarIds: AvatarCatalog["studentAvatarIds"] = {}): AvatarCatalog {
  const configured = configuredId?.trim();
  const match = avatars.find(avatar => avatar.id === configured);
  const preset = avatars.find(avatar => avatar.id === "builtin_claire_v1" && avatar.isPublic)
    ?? avatars.find(avatar => avatar.isPublic);
  const owned = avatars.find(avatar => !avatar.isPublic);
  // Explicit environment configuration wins. Otherwise prefer a real owned avatar.
  // An inaccessible configured ID falls back to a known public preset, with notice.
  const selected = match ?? (configured ? preset ?? owned : owned ?? preset);
  return {
    presets: avatars,
    studentAvatarIds,
    defaultAvatarId: selected?.id ?? "",
    warning: configured && !match
      ? selected ? "The configured student avatar is unavailable. Another available avatar is selected; you can choose a preset below."
        : "The configured student avatar is unavailable and this account has no available avatars."
      : null,
  };
}

export function selectLessonAvatar(catalog: AvatarCatalog, requestedId: unknown): string {
  const id = requestedId === undefined ? catalog.defaultAvatarId
    : typeof requestedId === "string" ? requestedId.trim() : "";
  if (!id || !catalog.presets.some(avatar => avatar.id === id)) {
    throw new Error("Choose an avatar available to your Boson account. Refresh avatar setup if access changed.");
  }
  return id;
}

export function avatarForStudent(catalog: AvatarCatalog, student: StudentSettings): string {
  return studentAvatarSelection(catalog, student).avatarId;
}

export function studentAvatarSelection(catalog: AvatarCatalog, student: StudentSettings): { avatarId: string; isFallback: boolean; notice: string | null } {
  const name = STUDENTS[student.id].name;
  const requested = catalog.studentAvatarIds?.[student.id]?.trim();
  const exact = requested
    ? catalog.presets.find(a => a.id === requested)
    : catalog.presets.find(a => a.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (exact) return { avatarId: exact.id, isFallback: false, notice: null };
  const configured = catalog.presets.find(a => a.id === catalog.defaultAvatarId);
  // An explicitly chosen account-owned face remains usable for either persona.
  if (!requested && configured && !configured.isPublic) return { avatarId: configured.id, isFallback: false, notice: `Using your account avatar: ${configured.name}.` };
  const preferred = STUDENTS[student.id].fallbackAvatarId;
  const fallback = catalog.presets.find(a => a.id === preferred) ?? configured;
  return { avatarId: fallback?.id ?? "", isFallback: true,
    notice: fallback ? `${name}’s ${requested ? "configured " : ""}live avatar is unavailable. Using ${fallback.name} as a fallback face.`
      : `No live avatar is available for ${name}.` };
}
