<script lang="ts">
  import {
    Avatar,
    ChevronRightIcon,
    ListItem,
    Skeleton,
    StarIcon,
    type Contact
  } from '@gphone/sdk';

  /**
   * The contact list: favourites first, then everyone else.
   *
   * The two groups are one component because they are one scroll region with one empty
   * state — splitting them would need a parent to own the "neither has anything" case.
   */
  let {
    favorites,
    others,
    total,
    loaded,
    query,
    onselect
  }: {
    favorites: Contact[];
    others: Contact[];
    /** Both groups combined, so the empty state knows the difference between no
     *  contacts and no matches. */
    total: number;
    loaded: boolean;
    query: string;
    onselect: (contact: Contact) => void;
  } = $props();
</script>

{#snippet contactItem(contact: Contact)}
  <ListItem onclick={() => onselect(contact)}>
    <div class="mr-4 shrink-0">
      <Avatar
        src={contact.avatar}
        initials={(contact.firstname[0] || '') + (contact.lastname?.[0] || '')}
        bgClass="bg-gray-800 border border-gray-700/60"
      />
    </div>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex items-center">
        <span class="truncate font-medium">
          {contact.firstname}
          {contact.lastname || ''}
        </span>
        {#if contact.favorite}
          <StarIcon class="ml-1.5 h-4 w-4 shrink-0 text-yellow-400" />
        {/if}
      </div>
      <span class="text-xs text-gray-400">{contact.phone}</span>
    </div>
  </ListItem>
{/snippet}

<div class="overflow-y-auto">
  {#if favorites.length > 0}
    <div>
      <div
        class="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 px-4 py-1 text-xs font-bold tracking-wider text-gray-400 uppercase backdrop-blur"
      >
        Favorites
      </div>
      <div class="divide-y divide-gray-800">
        {#each favorites as contact}
          {@render contactItem(contact)}
        {/each}
      </div>
    </div>
  {/if}

  {#if others.length > 0}
    <div>
      <div
        class="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 px-4 py-1 text-xs font-bold tracking-wider text-gray-400 uppercase backdrop-blur"
      >
        Contacts
      </div>
      <div class="divide-y divide-gray-800">
        {#each others as contact}
          {@render contactItem(contact)}
        {/each}
      </div>
    </div>
  {/if}

  {#if !loaded}
    <div class="p-3">
      <Skeleton count={6} height="h-14" />
    </div>
  {:else if total === 0}
    <div class="py-16 text-center text-sm text-gray-400">
      {query.trim() ? 'No matching contacts found.' : 'No contacts yet.'}
    </div>
  {/if}
</div>
