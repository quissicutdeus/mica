import type { Contact, Conversation, Mail, Message, Note, Photo } from '@shared/types';

/** Inject created_at / updated_at timestamps into a mock object. Accepts an optional offset (ms before now). */
const ts = (offsetMs: number = 0) => {
  const d = new Date(Date.now() - offsetMs).toISOString();
  return { created_at: d, updated_at: d } as const;
};

// Helper function to generate unique Robohash / DiceBear avatars
const getUniqueAvatar = (seed: string, setIndex: number = 1) => {
  const sets = [
    `https://robohash.org/${encodeURIComponent(seed)}.png?set=set1&bgset=bg1`,
    `https://robohash.org/${encodeURIComponent(seed)}.png?set=set2&bgset=bg2`,
    `https://robohash.org/${encodeURIComponent(seed)}.png?set=set4`,
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`,
    `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}`
  ];
  return sets[setIndex % sets.length];
};

// 20 distinct, non-repeating Unsplash photo URLs for gallery and image attachments
export const sampleAvatars = [
  'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1617814076367-b759c7d7e738?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1517849845537-4d257902454a?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1537151608828-ea2b11777ee8?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1561037404-61cd46aa615b?w=500&auto=format&fit=crop&q=80'
];

export const mockPhotos: Photo[] = sampleAvatars.map((url, index) => ({
  id: index + 1,
  citizenid: 'mock-id',
  image: url,
  status: 'active',
  ...ts()
}));

export const mockNotes: Note[] = [
  {
    id: 1,
    citizenid: '1',
    title: 'Grocery List',
    content:
      '- Milk\n- Eggs\n- Bread\n- Butter\n\n1. Union Depository Blueprint\n2. Keycards\n3. Thermal Charges',
    ...ts()
  },
  {
    id: 2,
    citizenid: '1',
    title: 'Project Ideas',
    content:
      '# Los Santos Jobs\n\n## Pacific Standard Heist\n### Diamond Casino Robbery\n#### Cayo Perico Freight',
    ...ts()
  }
];

// GTA V / FiveM Core Characters
const gtaCoreContacts: Contact[] = [
  {
    id: 1,
    citizenid: 'gta-ursula',
    firstname: 'Ursula',
    lastname: '(Crazy Ex)',
    phone: '555-0199',
    avatar:
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80',
    favorite: true,
    ...ts()
  },
  {
    id: 2,
    citizenid: 'gta-trevor',
    firstname: 'Trevor',
    lastname: 'Philips',
    phone: '555-0133',
    avatar: undefined, // Default silhouette
    favorite: true,
    ...ts()
  },
  {
    id: 3,
    citizenid: 'gta-simeon',
    firstname: 'Simeon',
    lastname: 'Yetarian',
    phone: '555-0144',
    avatar:
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=500&auto=format&fit=crop&q=80',
    favorite: false,
    ...ts()
  },
  {
    id: 4,
    citizenid: 'gta-lester',
    firstname: 'Lester',
    lastname: 'Crest',
    phone: '555-0155',
    avatar: undefined, // Default silhouette
    favorite: true,
    ...ts()
  },
  {
    id: 5,
    citizenid: 'gta-michael',
    firstname: 'Michael',
    lastname: 'De Santa',
    phone: '555-0166',
    avatar:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500&auto=format&fit=crop&q=80',
    favorite: true,
    ...ts()
  },
  {
    id: 6,
    citizenid: 'gta-franklin',
    firstname: 'Franklin',
    lastname: 'Clinton',
    phone: '555-0177',
    avatar:
      'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=500&auto=format&fit=crop&q=80',
    favorite: true,
    ...ts()
  },
  {
    id: 7,
    citizenid: 'gta-lamar',
    firstname: 'Lamar',
    lastname: 'Davis',
    phone: '555-0188',
    avatar:
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=500&auto=format&fit=crop&q=80',
    favorite: true,
    ...ts()
  },
  {
    id: 8,
    citizenid: 'gta-pavel',
    firstname: 'Pavel',
    lastname: '(Kosatka)',
    phone: '555-0111',
    avatar: undefined,
    favorite: false,
    ...ts()
  },
  {
    id: 9,
    citizenid: 'gta-agent14',
    firstname: 'Agent',
    lastname: '14',
    phone: '555-0122',
    avatar: undefined,
    favorite: false,
    ...ts()
  },
  {
    id: 10,
    citizenid: 'gta-tracey',
    firstname: 'Tracey',
    lastname: 'De Santa',
    phone: '555-0134',
    avatar:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=500&auto=format&fit=crop&q=80',
    favorite: false,
    ...ts()
  },
  {
    id: 11,
    citizenid: 'gta-ron',
    firstname: 'Ron',
    lastname: 'Jakowski',
    phone: '555-0145',
    avatar:
      'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=500&auto=format&fit=crop&q=80',
    favorite: false,
    ...ts()
  },
  {
    id: 12,
    citizenid: 'gta-solomon',
    firstname: 'Solomon',
    lastname: 'Richards',
    phone: '555-0156',
    avatar: undefined,
    favorite: false,
    ...ts()
  },
  {
    id: 13,
    citizenid: 'gta-brucie',
    firstname: 'Brucie',
    lastname: 'Kibbutz',
    phone: '555-0189',
    avatar:
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&auto=format&fit=crop&q=80',
    favorite: false,
    ...ts()
  }
];

const firstNames = [
  'Aaron',
  'Abigail',
  'Adam',
  'Adrian',
  'Alan',
  'Alex',
  'Alexander',
  'Alexis',
  'Alice',
  'Alicia',
  'Amanda',
  'Amber',
  'Amy',
  'Andrew',
  'Angela',
  'Ann',
  'Anna',
  'Anthony',
  'Arthur',
  'Ashley',
  'Austin',
  'Barbara',
  'Benjamin',
  'Bob',
  'Brandon',
  'Brian',
  'Brittany',
  'Bruce',
  'Bryan',
  'Caleb',
  'Cameron',
  'Carl',
  'Carlos',
  'Caroline',
  'Catherine',
  'Charles',
  'Charlotte',
  'Christian',
  'Christina',
  'Christopher',
  'Cody',
  'Connor',
  'Daniel',
  'David',
  'Dennis',
  'Diana',
  'Donald',
  'Donna',
  'Douglas',
  'Dylan',
  'Edward',
  'Elizabeth',
  'Emily',
  'Eric',
  'Ethan',
  'Eugene',
  'Evelyn',
  'Frank',
  'Gabriel',
  'George',
  'Gerald',
  'Gregory',
  'Hannah',
  'Harold',
  'Harry',
  'Heather',
  'Helen',
  'Henry',
  'Holly',
  'Ian',
  'Isaac',
  'Jack',
  'Jacob',
  'James',
  'Jason',
  'Jeffrey',
  'Jennifer',
  'Jerry',
  'Jesse',
  'Jessica'
];

const lastNames = [
  'Adams',
  'Alexander',
  'Allen',
  'Anderson',
  'Armstrong',
  'Arnold',
  'Bailey',
  'Baker',
  'Barnes',
  'Bell',
  'Bennett',
  'Berry',
  'Bishop',
  'Black',
  'Bradley',
  'Brooks',
  'Brown',
  'Bryant',
  'Burke',
  'Burns',
  'Butler',
  'Campbell',
  'Carlson',
  'Castillo',
  'Castro',
  'Chapman',
  'Chavez',
  'Clark',
  'Coleman',
  'Collins',
  'Cook',
  'Cooper',
  'Cox',
  'Cruz',
  'Cunningham',
  'Daniels',
  'Davis',
  'Delgado',
  'Diaz',
  'Dixon',
  'Drake',
  'Duncan',
  'Dunn',
  'Edwards',
  'Elliott',
  'Ellis',
  'Evans',
  'Ferguson',
  'Fernandez',
  'Flores',
  'Foster',
  'Fowler',
  'Fox',
  'Franklin',
  'Garcia',
  'Gardner',
  'Gibson',
  'Gomez',
  'Gonzalez',
  'Gordon',
  'Graham',
  'Grant',
  'Gray',
  'Green',
  'Griffin',
  'Hall',
  'Hamilton',
  'Hansen',
  'Harper',
  'Harris'
];

const generatedContacts: Contact[] = Array.from({ length: 87 }, (_, i) => {
  const fn = firstNames[i % firstNames.length];
  const ln = lastNames[i % lastNames.length];
  const seed = `${fn}-${ln}-${i}`;

  // Distribute between Robohash robots, monsters, cats, and DiceBear SVG avatars so every avatar URL is 100% unique!
  let avatar: string | undefined = undefined;
  if (i % 6 !== 0) {
    avatar = getUniqueAvatar(seed, i);
  }

  return {
    id: i + 14,
    citizenid: `cit-${i + 14}`,
    firstname: fn,
    lastname: ln,
    phone: `555-${String(200 + i).padStart(4, '0')}`,
    avatar,
    favorite: i % 15 === 0,
    ...ts()
  };
});

export const mockContacts: Contact[] = [...gtaCoreContacts, ...generatedContacts];

const conversationTitles: {
  is_group: boolean;
  name: string;
  phone: string;
  cit: string;
  avatar?: string;
}[] = [
  {
    is_group: false,
    name: 'Ursula (Crazy Ex)',
    phone: '555-0199',
    cit: 'gta-ursula',
    avatar:
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: true,
    name: 'Union Depository Heist',
    phone: 'group',
    cit: 'group-heist',
    avatar: getUniqueAvatar('heist-crew', 1)
  },
  {
    is_group: false,
    name: 'Trevor Philips',
    phone: '555-0133',
    cit: 'gta-trevor',
    avatar: undefined
  },
  {
    is_group: true,
    name: 'LSPD Central Dispatch',
    phone: 'group',
    cit: 'group-lspd',
    avatar:
      'https://images.unsplash.com/photo-1617814076367-b759c7d7e738?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Simeon Yetarian',
    phone: '555-0144',
    cit: 'gta-simeon',
    avatar:
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: true,
    name: 'Los Santos Tuners Club',
    phone: 'group',
    cit: 'group-tuners',
    avatar:
      'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Lester Crest',
    phone: '555-0155',
    cit: 'gta-lester',
    avatar: undefined
  },
  {
    is_group: false,
    name: 'Michael De Santa',
    phone: '555-0166',
    cit: 'gta-michael',
    avatar:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: true,
    name: 'Dynasty 8 Executive VIPs',
    phone: 'group',
    cit: 'group-realestate',
    avatar: getUniqueAvatar('dynasty-8', 2)
  },
  {
    is_group: false,
    name: 'Franklin Clinton',
    phone: '555-0177',
    cit: 'gta-franklin',
    avatar:
      'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Lamar Davis',
    phone: '555-0188',
    cit: 'gta-lamar',
    avatar:
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: true,
    name: 'Diamond Casino VIPs',
    phone: 'group',
    cit: 'group-casino',
    avatar:
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Pavel (Kosatka)',
    phone: '555-0111',
    cit: 'gta-pavel',
    avatar: undefined
  },
  {
    is_group: true,
    name: "Benny's Motorworks",
    phone: 'group',
    cit: 'group-bennys',
    avatar:
      'https://images.unsplash.com/photo-1517849845537-4d257902454a?w=500&auto=format&fit=crop&q=80'
  },
  { is_group: false, name: 'Agent 14', phone: '555-0122', cit: 'gta-agent14', avatar: undefined },
  {
    is_group: true,
    name: 'Pillbox Hill EMS',
    phone: 'group',
    cit: 'group-ems',
    avatar: getUniqueAvatar('pillbox-ems', 4)
  },
  {
    is_group: false,
    name: 'Tracey De Santa',
    phone: '555-0134',
    cit: 'gta-tracey',
    avatar:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Ron Jakowski',
    phone: '555-0145',
    cit: 'gta-ron',
    avatar:
      'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: true,
    name: 'Vanilla Unicorn VIP',
    phone: 'group',
    cit: 'group-unicorn',
    avatar:
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=500&auto=format&fit=crop&q=80'
  },
  {
    is_group: false,
    name: 'Solomon Richards',
    phone: '555-0156',
    cit: 'gta-solomon',
    avatar: undefined
  }
];

const crazyExPrompts = [
  "Hey babe! Why haven't you answered my last text from 5 minutes ago? 😊",
  "Seriously where are you? I'm getting worried.",
  'I saw your Zentorno parked outside Tequi-la-la. WHO ARE YOU WITH?!',
  "Don't play games with me.",
  "I know you're looking at your phone right now!",
  'Answer me!',
  "CALL ME NOW OR I'M CUTTING YOUR TIRES!",
  'I called 18 times why is it going straight to voicemail?!',
  'Who was that blonde in your passenger seat yesterday?!',
  "I still have your favorite hoodie and I'm currently holding a lighter.",
  'My mother warned me about guys from Davis!',
  'I just drove past your apartment and your lights are ON!',
  'WHY ARE YOU DOING THIS TO US?!',
  "Fine. We're done. Blocked.",
  "Wait I didn't mean that I love you please answer.",
  'PICK UP!',
  'HELLO????',
  "I'm standing on your front porch right now.",
  'I can hear your phone ringing inside.',
  'Open the door.',
  'I brought my cat.',
  'We need to talk about our future.',
  'Answer or I start screaming.',
  '3...',
  '2...',
  '1... 🤬😡🗯️‼️'
];

const gtaPromptsByConv: Record<number, string[]> = {
  1: crazyExPrompts,
  2: [
    'Lester: We need two driller drivers and a heavy gunner.',
    'Trevor: I get 40% or I blow up the getaway van.',
    'Michael: Nobody gets greedy. Stick to the plan.',
    'Franklin: Cops are calling in SWAT teams near Pillbox!',
    'Lester: Get to the subway tunnels NOW.'
  ],
  3: [
    'I need 50 gallons of aviation fuel and a clean flatbed truck.',
    "Don't look at me like that, I'm expressing myself!",
    'Wade lost my favorite machete in Sandy Shores.',
    'Patricia said hi. Tell Michael he owes me $10,000.',
    'Meet me at the airfield before I lose my temper!'
  ],
  4: [
    'DISPATCH: CODE 3 - Shots fired at Vespucci Boulevard.',
    'Officer 24: Suspect in a matte black Elegy RH8 heading north on Del Perro Freeway.',
    'DISPATCH: Air Support unit deployed.',
    'Officer 12: We lost visual near the Vinewood Hills tunnels.'
  ],
  5: [
    'My friend! You are a racist if you do not buy this Paragon R today!',
    'Jimmy De Santa still owes me for the Obey Tailgater!',
    'I give you best price in all of Los Santos!',
    'Come to Premium Deluxe Motorsport right now.'
  ]
};

const defaultGtaPrompts = [
  'Yo, you active right now in Los Santos?',
  'Check out this photo from the rooftop meetup!',
  'Bounty placed on target near Sandy Shores.',
  'Meet at the LS International Airport Hangar 4.',
  'Got the shipment ready for transport.',
  'BULL SHARK TESTOSTERONE BABY! GENETIC SUPERIORITY!',
  'Kapitan! Sonar is picking up submerged cargo near Cayo Perico.',
  'Supply run successful. Bunker stock increased.'
];

export const mockMessages: Record<number, Message[]> = {};

export const mockConversations: Conversation[] = conversationTitles.map((c, convIndex) => {
  const convId = convIndex + 1;
  const convTimeOffset = convIndex * 1.4 * 24 * 60 * 60 * 1000;
  const promptList = gtaPromptsByConv[convId] || defaultGtaPrompts;

  const isCrazyEx = convId === 1;
  const isSentByMeRead =
    !isCrazyEx && (convId === 2 || convId === 5 || (convId > 7 && convId % 3 === 0));
  const isSentByMeDelivered =
    !isCrazyEx && (convId === 3 || convId === 6 || (convId > 7 && convId % 3 === 1));
  const isOtherUnread = !isCrazyEx && (convId === 4 || (convId > 7 && convId % 3 === 2));

  const groupMembers = c.is_group
    ? mockContacts.slice((convIndex * 3) % 10, ((convIndex * 3) % 10) + 4)
    : [];
  const matchingContact = mockContacts.find((mc) => mc.phone === c.phone || mc.citizenid === c.cit);

  const msgList: Message[] = Array.from({ length: 200 }, (_, mIndex) => {
    const isUnreadExMsg = isCrazyEx && mIndex >= 175;
    let isMe = mIndex % 2 === 0;
    let senderCit = isMe ? 'my-id' : c.cit;

    if (c.is_group && groupMembers.length > 0) {
      if (!isMe) {
        const member = groupMembers[mIndex % groupMembers.length];
        senderCit = member.citizenid;
      }
    } else if (isCrazyEx) {
      isMe = mIndex < 175 ? mIndex % 2 === 0 : false;
      senderCit = isMe ? 'my-id' : c.cit;
    } else if (isSentByMeRead || isSentByMeDelivered) {
      isMe = mIndex % 2 === 1;
      senderCit = isMe ? 'my-id' : c.cit;
    } else if (isOtherUnread) {
      isMe = mIndex % 2 === 0;
      senderCit = isMe ? 'my-id' : c.cit;
    }

    const hasAttachment = !isCrazyEx && mIndex % 25 === 12;
    const multiAttachment = !isCrazyEx && mIndex % 50 === 37;
    const text = isUnreadExMsg
      ? crazyExPrompts[mIndex - 175]
      : promptList[mIndex % promptList.length];

    let attachments: { id?: number; attachment?: string }[] | undefined = undefined;
    if (multiAttachment) {
      attachments = [
        { id: 1, attachment: sampleAvatars[(mIndex + convIndex) % sampleAvatars.length] },
        { id: 2, attachment: sampleAvatars[(mIndex + convIndex + 5) % sampleAvatars.length] }
      ];
    } else if (hasAttachment) {
      attachments = [
        { id: 1, attachment: sampleAvatars[(mIndex + convIndex) % sampleAvatars.length] }
      ];
    }

    const msgOffset = (199 - mIndex) * (isUnreadExMsg ? 2 : 36) * 60 * 1000;
    const msgTime = new Date(Date.now() - convTimeOffset - msgOffset).toISOString();

    return {
      id: convId * 1000 + mIndex + 1,
      conversation_id: convId,
      citizenid: senderCit,
      status: 'active',
      message: text,
      attachments,
      created_at: msgTime,
      updated_at: msgTime
    };
  });

  mockMessages[convId] = msgList;

  const lastMsg = msgList[msgList.length - 1];

  const unreadCount = isCrazyEx ? 25 : isOtherUnread ? 1 : 0;

  let recipientLastRead: string;
  if (isCrazyEx) {
    recipientLastRead = (msgList[174]?.created_at || new Date().toISOString()) as string;
  } else if (isSentByMeRead) {
    recipientLastRead = lastMsg.created_at as string;
  } else if (isSentByMeDelivered) {
    recipientLastRead = (msgList[198]?.created_at ||
      new Date(Date.now() - 3600000).toISOString()) as string;
  } else if (isOtherUnread) {
    recipientLastRead = (msgList[198]?.created_at || lastMsg.created_at) as string;
  } else {
    recipientLastRead = lastMsg.created_at as string;
  }

  return {
    id: convId,
    citizenid: 'my-id',
    is_group: c.is_group,
    name: c.name,
    status: 'active',
    created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
    updated_at: lastMsg.created_at,
    unread_count: unreadCount,
    last_message: lastMsg,
    participants: c.is_group
      ? groupMembers.map((member, idx) => ({
          id: convId * 100 + idx,
          conversation_id: convId,
          citizenid: member.citizenid,
          role: idx === 0 ? 'admin' : 'member',
          status: 'active',
          last_read: ts().created_at,
          ...ts(),
          contact: member
        }))
      : [
          {
            id: convId * 10,
            conversation_id: convId,
            citizenid: c.cit,
            role: 'member',
            status: 'active',
            last_read: recipientLastRead,
            ...ts(),
            contact: matchingContact || {
              id: convId,
              citizenid: c.cit,
              firstname: c.name.split(' ')[0] || c.name,
              lastname: c.name.split(' ')[1] || '',
              phone: c.phone,
              avatar: c.avatar,
              favorite: false,
              ...ts()
            }
          }
        ]
  };
});

export const mockEmails: Mail[] = [
  {
    id: 1,
    citizenid: 'mock-id',
    sender: 'Fleeca Bank',
    sender_address: 'alerts@fleeca.com',
    subject: 'Account Statement Available',
    content:
      'Your monthly bank statement for account #4242 is now ready to view. Balance: $15,450.00.',
    status: 'active',
    read: false,
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 30).toISOString()
  },
  {
    id: 2,
    citizenid: 'mock-id',
    sender: 'Los Santos Police Dept',
    sender_address: 'no-reply@lspd.gov',
    subject: 'Traffic Citation Notice',
    content:
      "Notice: Citation #90214 has been registered for your vehicle. Please settle all outstanding balances at the City Hall clerk's office.",
    status: 'active',
    read: true,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString()
  },
  {
    id: 3,
    citizenid: 'mock-id',
    sender: 'Dynasty 8 Executive',
    sender_address: 'sales@dynasty8realestate.com',
    subject: 'Property Listing Update',
    content:
      'New luxury apartment listings are now available in Rockford Hills. Contact an agent for private showings.',
    status: 'active',
    read: true,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString()
  }
];
