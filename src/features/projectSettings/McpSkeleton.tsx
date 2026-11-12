// What the MCP tab draws while a file is still being read: the shape of a server card, or of the JSON editor,
// never a line of text, so the tab keeps its size when the real content arrives.
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';

const MCP_SKELETON_CARDS = 2;

export function McpCardsSkeleton() {
  return (
    <div className="mcp-list">
      <SkeletonRows
        count={MCP_SKELETON_CARDS}
        row={(widthPercent) => (
          <div className="mcp-card mcp-card-head">
            <Skeleton width="28px" height="28px" radius="6px" />
            <div className="mcp-card-text">
              <Skeleton width={`${widthPercent}%`} />
              <Skeleton width="40%" />
            </div>
          </div>
        )}
      />
    </div>
  );
}

export function McpEditorSkeleton() {
  return <Skeleton width="100%" height="9rem" radius="var(--radius)" />;
}
