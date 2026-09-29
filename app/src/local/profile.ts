/** The person using this device: name shown in audit entries and reports, and display preferences. */
import { db } from "./db";

export interface Profile {
  name: string;
  preferences: { display_unit?: string; thresholds?: { high: number; medium: number } };
}

export async function getProfile(): Promise<Profile> {
  const p = (await (await db()).get("meta", "profile")) as Profile | undefined;
  return { name: p?.name ?? "", preferences: p?.preferences ?? {} };
}

export async function setProfile(p: Profile): Promise<void> {
  await (await db()).put("meta", p, "profile");
}
