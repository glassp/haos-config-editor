import type { ScalarTag } from 'yaml';

/** Tags Home Assistant adds on top of YAML. They all take a scalar argument. */
export const HA_TAG_NAMES = [
  '!secret',
  '!include',
  '!include_dir_list',
  '!include_dir_merge_list',
  '!include_dir_named',
  '!include_dir_merge_named',
  '!env_var',
  '!input',
] as const;

export const haTags: ScalarTag[] = HA_TAG_NAMES.map((tag) => ({
  tag,
  resolve: (str: string) => str,
}));

export const isHaTag = (tag: string | undefined): tag is (typeof HA_TAG_NAMES)[number] =>
  !!tag && (HA_TAG_NAMES as readonly string[]).includes(tag);
