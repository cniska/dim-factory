import { refuser } from "./coded-error";

type WorkspaceRefusalMeta = {
  readonly workspace_failed: { readonly dir: string; readonly detail: string };
};

export const refuseWorkspace = refuser<WorkspaceRefusalMeta>({
  workspace_failed: {
    message: ({ dir, detail }) => `git could not make the workspace ${dir}: ${detail}`,
    resolve: () => "dim doctor",
  },
});
