/**
 * What an open editor tab should do with a file state reported by the watcher (pure, unit-tested).
 *
 * tab:   { version, saving, reloading, lastSavedAt, deleted, conflictVersion }
 * stat:  { exists, version }   (version = mtime_ns + size + inode, see file_version())
 * Returns one of:
 *   "ignore"    our own save is in flight / just finished, or the poll started before it
 *   "deleted"   the file disappeared from disk
 *   "restored"  the file is back on disk, unchanged versus what we have
 *   "reload"    changed on disk, no local edits: take the disk version
 *   "conflict"  changed on disk while there are local edits: ask the user (once per disk version)
 *   "none"      nothing to do
 */
export function fileChangeAction(tab, stat, requestedAt, dirty) {
	if (tab.saving || tab.reloading) return "ignore";
	if (requestedAt <= (tab.lastSavedAt || 0)) return "ignore";

	if (!stat.exists) return tab.deleted ? "none" : "deleted";

	if (stat.version === tab.version) return tab.deleted ? "restored" : "none";
	if (!dirty) return "reload";
	return tab.conflictVersion === stat.version ? "none" : "conflict";
}
