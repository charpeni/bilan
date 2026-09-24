/** R2 key of the gzipped dashboard payload for one sync of a repo. */
export function payloadKey(repoId: string, syncedAt: string): string {
  return `payload/${repoId}/${syncedAt}.json.gz`;
}
