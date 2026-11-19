import { AdminThread } from "./admin-thread";

export default async function ConversationPage({
  params,
}: PageProps<"/admin/c/[conversationId]">) {
  const { conversationId } = await params;
  return <AdminThread key={conversationId} conversationId={conversationId} />;
}
