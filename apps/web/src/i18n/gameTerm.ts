// Job 028: `@scm/gamedata` display names (part/machine/recipe names, e.g.
// `"Iron Ore"`, `"Miner Mk.2"`, `"Assembler"`) are looked up directly as
// flat keys in the `translation` namespace — the original tool's string
// table already carries an entry for every one of them (an identity mapping
// in `en-US.json`, a real translation in every other locale, e.g. `de.json`
// maps `"Iron Ore"` -> `"Eisenerz"`). `defaultValue: name` covers any name
// that isn't in the table for some reason (a future `game_data.json`
// update adding a part ahead of the string table catching up) by falling
// back to the raw English name instead of rendering a raw i18next "missing
// key" placeholder.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export function useGameTerm(): (name: string) => string {
  const { t } = useTranslation();
  return useCallback((name: string) => t(name, { defaultValue: name }), [t]);
}
