import { refuser } from "./coded-error";

type WorkspaceRefusalMeta = {
  readonly workspace_failed: { readonly dir: string; readonly detail: string };
};

export const refuseWorkspace = refuser<WorkspaceRefusalMeta>({
  workspace_failed: {
    message: ({ dir, detail }) => `git could not add the order's worktree at ${dir}: ${detail}`,
    resolve: () => "dim order run <order> once the cause git reports is gone; it retries the workspace",
  },
});
