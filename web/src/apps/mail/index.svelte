<script lang="ts">
  import {
    onAppForeground,
    useAppLevels,
    useDeepLink,
    useMail,
    type Mail,
    EmptyState,
    ListItem,
    Screen,
    Skeleton,
    ArchiveIcon,
    EmptyMailIcon,
    TrashIcon,
    formatRelativeTime,
    type AppProps
  } from '@gphone/sdk';

  const { mailStore } = useMail();
  const mailLoaded = mailStore.loaded;

  let { onback, mailId }: AppProps & { mailId?: number } = $props();
  let selectedMail = $state<Mail | null>(null);
  let activeTab = $state<'inbox' | 'archive'>('inbox');

  const app = useAppLevels({
    appId: 'mail',
    title: () => (activeTab === 'inbox' ? 'Mail' : 'Archived Mail'),
    onback: () => onback(),
    levels: [{ open: () => !!selectedMail, close: closeDetail, title: 'Message' }]
  });

  // Every visit, not only the first. Mail that arrived while the app sat in the
  // background is pushed in, but a message read or deleted elsewhere is not.
  onAppForeground('mail', () => {
    void mailStore.load();
  });

  useDeepLink('mail', () => {
    if (!mailId) return false;
    const found = $mailStore.find((m) => m.id === mailId);
    if (!found) return false;
    openMail(found);
    return true;
  });

  let activeEmails = $derived($mailStore.filter((m) => (m.status || 'active') === 'active'));

  let archivedEmails = $derived($mailStore.filter((m) => m.status === 'archived'));

  let displayedEmails = $derived(activeTab === 'inbox' ? activeEmails : archivedEmails);

  function openMail(email: Mail) {
    selectedMail = email;
    if (!email.read) {
      mailStore.markAsRead(email.id);
    }
  }

  function closeDetail() {
    selectedMail = null;
  }

  function handleArchive(email: Mail) {
    const isArchived = email.status === 'archived';
    mailStore.archive(email.id, !isArchived);
    if (selectedMail && selectedMail.id === email.id) {
      selectedMail = { ...selectedMail, status: !isArchived ? 'archived' : 'active' };
    }
  }

  function handleDelete(emailId: number) {
    mailStore.delete(emailId);
    if (selectedMail && selectedMail.id === emailId) {
      selectedMail = null;
    }
  }
</script>

{#snippet headerActions()}
  {#if selectedMail}
    {@const isArchived = selectedMail.status === 'archived'}
    <div class="ml-auto flex items-center space-x-1">
      <button
        class="text-error hover:bg-error rounded-full p-2 transition-colors"
        onclick={() => handleDelete(selectedMail!.id)}
        aria-label="Delete message"
        title="Delete message"
      >
        <TrashIcon class="h-5 w-5" />
      </button>
      <button
        class={`rounded-full p-2 transition-colors ${
          isArchived
            ? 'bg-primary text-primary hover:bg-primary'
            : 'text-on-surface hover:bg-surface-container-high hover:text-on-surface'
        }`}
        onclick={() => handleArchive(selectedMail!)}
        aria-label={isArchived ? 'Move to Inbox' : 'Archive message'}
        title={isArchived ? 'Move to Inbox' : 'Archive message'}
      >
        <ArchiveIcon class="h-5 w-5" />
      </button>
    </div>
  {:else}
    <button
      class={`ml-auto rounded-full p-2 transition-colors ${
        activeTab === 'archive'
          ? 'bg-surface-container-low text-primary'
          : 'hover:bg-surface text-on-surface hover:text-on-surface'
      }`}
      onclick={() => (activeTab = activeTab === 'inbox' ? 'archive' : 'inbox')}
      aria-label={activeTab === 'inbox' ? 'View Archive' : 'View Inbox'}
      title={activeTab === 'inbox' ? 'View Archive' : 'View Inbox'}
    >
      <ArchiveIcon class="h-5 w-5" />
    </button>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions}>
  {#if selectedMail}
    <!-- Detail View -->
    <div class="flex h-full flex-col p-4">
      <div class="border-outline-variant mb-4 border-b pb-3">
        <div class="mb-2 flex items-start justify-between">
          <div>
            <h2 class="text-on-surface text-lg font-bold">{selectedMail.sender}</h2>
            {#if selectedMail.sender_address}
              <p class="text-on-surface-variant text-xs">{selectedMail.sender_address}</p>
            {/if}
          </div>
          <span class="text-on-surface-variant text-xs"
            >{formatRelativeTime(selectedMail.created_at)}</span
          >
        </div>
        <h3 class="text-md text-primary mt-2 font-semibold">{selectedMail.subject}</h3>
      </div>

      <div
        class="text-on-surface flex-1 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap"
      >
        {selectedMail.content}
      </div>
    </div>
  {:else}
    <!-- Email List -->
    <div class="divide-outline-variant divide-y">
      {#if !$mailLoaded}
        <Skeleton count={4} height="h-16" />
      {:else if displayedEmails.length === 0}
        <EmptyState
          title={activeTab === 'inbox' ? 'No inbox messages' : 'No archived messages'}
          description={activeTab === 'inbox'
            ? 'System dispatches and official mail will appear here.'
            : 'Archived messages will be stored here.'}
        >
          {#snippet icon()}
            <EmptyMailIcon class="h-12 w-12" />
          {/snippet}
        </EmptyState>
      {:else}
        {#each displayedEmails as email (email.id)}
          <ListItem onclick={() => openMail(email)} class="flex items-start space-x-3">
            <div class="pt-1">
              {#if !email.read && activeTab === 'inbox'}
                <span class="bg-primary block h-2.5 w-2.5 rounded-full"></span>
              {:else}
                <span class="block h-2.5 w-2.5 rounded-full bg-transparent"></span>
              {/if}
            </div>

            <div class="min-w-0 flex-1">
              <div class="mb-0.5 flex items-baseline justify-between">
                <h3
                  class={`truncate text-sm font-medium ${!email.read ? 'text-on-surface font-bold' : 'text-on-surface'}`}
                >
                  {email.sender}
                </h3>
                <span class="text-on-surface-variant ml-2 text-xs whitespace-nowrap">
                  {formatRelativeTime(email.created_at)}
                </span>
              </div>
              <h4
                class={`mb-1 truncate text-xs ${!email.read ? 'text-primary font-semibold' : 'text-on-surface-variant'}`}
              >
                {email.subject}
              </h4>
              <p class="text-on-surface-variant line-clamp-2 text-xs leading-relaxed">
                {email.content}
              </p>
            </div>
          </ListItem>
        {/each}
      {/if}
    </div>
  {/if}
</Screen>
