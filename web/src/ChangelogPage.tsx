import changelogMarkdown from "../../CHANGELOG.md?raw";
import { MessageResponse } from "@/components/ai-elements/message";

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-xl space-y-5 pb-10">
      <article className="markdown rounded-2xl border border-border bg-card/40 px-4 py-4">
        <MessageResponse>{changelogMarkdown}</MessageResponse>
      </article>
    </div>
  );
}
