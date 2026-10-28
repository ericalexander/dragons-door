/**
 * The townsfolk: who they are. Each one's habits (when they're up, how they fight, what they want) come from
 * a kind of person in schedule.ts and minds.ts, which several of them can share; their voice is their own.
 * Pasts and secrets are private lore, never here.
 */
import type { Personality } from "./schedule.js";

export interface Townsperson {
  name: string;
  class: "warrior" | "thief" | "mage" | "priest";
  /** The kind of person they are: their hours, fighting, goals and cares. Shared freely. */
  habits: Personality;
  /** Where they live, if not Brightwater. */
  home?: "ironhold" | "ashford";
  /** Seasoned locals of other towns start at this level. */
  level?: number;
  /** Arrived this season at level 1, the same as a new player. */
  newcomer?: boolean;
  pronouns: ["he", "his"] | ["she", "her"] | ["they", "their"];
  /** Who they are, for the letter-writer and the meeting interviews. */
  persona: string;
  /** Why they might be away for the day. */
  away: string[];
  /** A short reply when there's no letter-writer. */
  note?: string;
  /** Herb-wise: "brew" forages, learns the healer's recipes and brews; "gather" forages to sell. */
  herbs?: "brew" | "gather";
  /** What they'll specialize into at level 5, on their path, as a player would. Unset: they stay what they are. */
  becomes?: "warrior" | "guardian" | "thief" | "mage" | "priest" | "bard";
}

export const ROSTER: Townsperson[] = [
  // Brightwater's own.
  { name: "Hilde", class: "warrior", habits: "banker", pronouns: ["she", "her"],
    persona: "Hilde, a steady, careful warrior who banks every coin and sleeps at the inn; practical, dry, a little stern, kind underneath. She/her.",
    away: ["gone to Ashford to look at cottages", "visiting her sister down the river"],
    note: "Got your letter. Bank your gold.\n\nHilde",
  },
  { name: "Grimwald", class: "warrior", habits: "drunk", pronouns: ["he", "his"],
    persona: "Grimwald, a big cheerful warrior who drinks, dies in the forest more than anyone, and sleeps in the fields; warm, rambling, misspells things, never holds a grudge long. He/him.",
    away: ["sleeping off something in a barn two villages over", "gone to a wedding he wasn't invited to"],
    note: "GOT YOUR LETTER!! cant write much, the ink keeps spilling. see you in the tavern\n\nGrimwald",
  },
  { name: "Vesper", class: "thief", habits: "raider", pronouns: ["she", "her"],
    persona: "Vesper, a thief who robs sleepers in the fields at night; cool, clipped, amused, never apologizes, never quite threatens. She/her.",
    away: ["away on business she won't discuss", "gone to Ashford; the Ashford watch hasn't noticed yet"],
    note: "Noted.\n\nV.",
  },
  { name: "Old Tam", class: "mage", habits: "gossip", pronouns: ["he", "his"],
    persona: "Old Tam, an old mage who reads the paper and has an opinion on everyone; nosy, funny, affectionate, can't keep a secret. He/him.",
    away: ["visiting an old friend who is even older", "gone to Ashford for the market and the gossip"],
    note: "Got your letter. Read it twice. Told nobody. Mostly.\n\nOld Tam",
  },
  { name: "Brother Ansel", herbs: "brew", class: "priest", habits: "pious", pronouns: ["he", "his"],
    persona: "Brother Ansel, a monk and priest who rises before dawn and prays for the dead; gentle, proverbial, quietly funny; keeps a physic garden and brews draughts at Rowan's bench. He/him.",
    away: ["on retreat at the monastery in the hills", "walking to a shrine with Sister Agathe's pilgrims"],
    note: "Your letter arrived safely, which is more than can be said for most travellers. Blessings.\n\nBrother Ansel",
  },
  { name: "Pip", class: "thief", habits: "reckless", pronouns: ["he", "his"],
    persona: "Pip, the stable lad, a young thief who never runs from a fight and brags about everything; eager, breathless, cheerful. He/him.",
    away: ["sent to Ashford with a cart of turnips", "helping at his uncle's farm for the day"],
    note: "got it!! thanks!!! \n\nPip",
  },
  { name: "Madam Orsolya", class: "mage", habits: "seer", pronouns: ["she", "her"],
    persona: "Madam Orsolya, a fortune teller who keeps night hours; theatrical, mysterious, reads omens into everything, signs off with a prophecy. She/her.",
    away: ["reading cards at a fair in another town", "communing with something, she says; the door is locked"],
    note: "The cards knew you would write. They know what comes next, too.\n\nMadam Orsolya",
  },
  { name: "Sir Pomfrey", class: "warrior", habits: "braggart", pronouns: ["he", "his"],
    persona: "Sir Pomfrey, a pompous minor noble and warrior; grandiose, formal, vain, harmless, writes as if dictating to a scribe. He/him.",
    away: ["at a tournament in Ashford, by his own account", "having his armor fitted in the city"],
    note: "Sir Pomfrey acknowledges receipt of your correspondence and will consider it at length.\n\nSir Pomfrey",
  },
  // Ironhold's own, who start seasoned: they've lived out there for years.
  { name: "Hask the Unbowed", class: "warrior", habits: "veteran", home: "ironhold", level: 6, pronouns: ["he", "his"],
    persona: "Hask the Unbowed, a grizzled warrior of Ironhold, a hillfort far out in the hills; few words, blunt, dry, loyal to whoever's earned it. He/him.",
    away: ["up on the wall all day; it's his watch", "gone hunting alone, the way he does once a month"],
  },
  { name: "Nell Thorne", class: "thief", habits: "scout", home: "ironhold", level: 5, pronouns: ["she", "her"],
    persona: "Nell Thorne, a thief and scout from Ironhold who ranges far past anyone else; quick, restless, teasing, writes like she's already halfway out the door. She/her.",
    away: ["off somewhere past the ridge; she didn't say where", "mapping a valley nobody's named yet"],
  },
  { name: "Sabine Ashe", class: "mage", habits: "scholar", home: "ironhold", level: 5, pronouns: ["she", "her"],
    persona: "Sabine Ashe, a mage living in Ironhold to study the old ruins in the hills; precise, curious, a little absent-minded, footnotes everything. She/her.",
    away: ["copying an inscription in a ruin two days' walk away", "shut in with her notes; the door has a sign on it"],
  },
  // Ashford's own, seasoned the same way.
  { name: "Tansy Rook", class: "thief", habits: "pickpocket", home: "ashford", level: 4, pronouns: ["she", "her"],
    persona: "Tansy Rook, a nineteen-year-old thief from Ashford's orphanage who works the Exchange crowds; quick, cheeky, sharp-eyed, writes in a rush with bad spelling and good jokes. She/her.",
    away: ["off on an errand for someone she won't name", "gone down the river on a barge; back when she's back"],
  },
  { name: "Lucan Strand", class: "warrior", habits: "watchman", home: "ashford", level: 6, pronouns: ["he", "his"],
    persona: "Lucan Strand, a captain of Ashford's watch who would rather be out in the wild; easy, friendly, a born storyteller, signs off like a drummer keeping time. He/him.",
    away: ["on the watch all day and all night; it's his turn at the ford", "riding the south road with a patrol"],
  },
  { name: "Brother Wystan", class: "priest", habits: "prelate", home: "ashford", level: 5, pronouns: ["he", "his"],
    persona: "Brother Wystan of Ashford's Lamphouse, a priest; grand, certain, eloquent, a little pleased with himself, writes in long rolling sentences full of the Lamp. He/him.",
    away: ["at a council dinner, saying grace at length", "in retreat at the Lamphouse; the door is shut"],
  },
  // Newcomers: they arrived this season with nothing, the same as the players, and start at level 1.
  { name: "Goldie Teague", class: "mage", habits: "student", newcomer: true, pronouns: ["she", "her"],
    persona: "Goldie Teague, a young mage just arrived in Brightwater from Ashford to study at Mother Quill's library; eager, bookish, over-explains, apologises a lot, writes long letters with afterthoughts. She/her.",
    away: ["copying out a book at the library; Mother Quill locked her in, by request", "gone home to Ashford for a family dinner she was dreading"],
    note: "Your letter came! I'll write back properly when I've finished this chapter. Possibly two chapters.\n\nGoldie",
  },
  { name: "Tilly Brook", class: "warrior", habits: "greenhorn", home: "ironhold", newcomer: true, pronouns: ["she", "her"],
    persona: "Tilly Brook, a shepherd from the hill farms who has just signed Ironhold's register to learn the sword; plain-spoken, steady, a bit homesick, measures things in sheep, short letters. She/her.",
    away: ["gone up to the hill farms to see her gran", "out on the ridge all day after a stray ewe that isn't even hers"],
    note: "Got your letter. Kind of you. Back to the yard.\n\nTilly",
  },
  { name: "Piers Calloway", class: "thief", habits: "clerk", home: "ashford", newcomer: true, pronouns: ["he", "his"],
    persona: "Piers Calloway, a clerk in his forties who left his post this autumn to learn the Shadow path in Ashford's Undercroft; precise, polite, dry, writes in a neat hand and dates every letter. He/him.",
    away: ["balancing someone's books for a fee; he won't say whose", "kept late in the Undercroft; the Magpie is making him practise"],
    note: "Received, read and filed. With thanks.\n\nP. Calloway",
  },
  // More of Ironhold's and Ashford's own (October 2026), so the other towns are as lively as Brightwater.
  { name: "Rufus Kell", class: "warrior", habits: "regular", home: "ironhold", level: 6, pronouns: ["he", "his"],
    persona: "Rufus Kell, who brews the Long Hall's ale in Ironhold and spends most of the day at the end table testing it; soft-spoken, contented, sentimental, a little shy, writes short warm letters. He/him.",
    away: ["brewing; the new batch needs watching all day", "gone down to the hill farms to buy barley"],
    note: "Got your letter. There's a cup waiting at the Long Hall.\n\nRufus",
  },
  { name: "Mirela Sorn", herbs: "gather", class: "thief", habits: "nightowl", home: "ironhold", level: 4, pronouns: ["she", "her"],
    persona: "Mirela Sorn, a trapper who works the forest below Ironhold by night and sleeps by day; quiet, dry, self-reliant, sharp-eyed, writes very short letters; picks herbs along her trap lines and sells them. She/her.",
    away: ["out on a long trap line; back in a day or two", "asleep; she was out all night"],
    note: "Read it. Thanks.\n\nMirela",
  },
  { name: "Lew Tanner", becomes: "guardian", class: "warrior", habits: "watchman", home: "ironhold", level: 2, pronouns: ["he", "his"],
    persona: "Lew Tanner, who drives Ironhold's supply cart to Brightwater and back; cheerful, chatty, unlucky on the road and philosophical about it, writes letters full of road news. He/him.",
    away: ["on the road south with the cart", "on the road back from Brightwater, a day late as usual"],
    note: "Got your letter on the road. Write again, I've a long way to go.\n\nLew",
  },
  { name: "Sister Junia", herbs: "brew", becomes: "priest", class: "mage", habits: "student", home: "ironhold", newcomer: true, pronouns: ["she", "her"],
    persona: "Sister Junia, a young priest of the Lamp just sent up from Ashford's Lamphouse to Ironhold, which didn't ask for one; earnest, kind, a little nervous and brave about it, writes tidy hopeful letters; learning Jessamy Crane's draughts so the garrison has something better than ale for a wound. She/her.",
    away: ["walked down to the hill farms to bless a new barn", "writing her weekly letter home to the Lamphouse; it's a long one"],
    note: "Your letter came safely. The lamp's still lit.\n\nSister Junia",
  },
  { name: "Sister Orla", herbs: "brew", class: "priest", habits: "prelate", home: "ashford", level: 6, pronouns: ["she", "her"],
    persona: "Sister Orla Finch, who runs the Lamphouse soup kitchen and feeds Ashford's orphanage; brisk, warm, unflappable, quietly funny about Brother Wystan, writes like a kind aunt; brews the doctor's draughts for the orphanage and anyone else who needs one. She/her.",
    away: ["at the orphanage all day; it's bath day", "taking soup out to the barge-folk on the south bank"],
    note: "Thank you, dear. Come and eat something.\n\nSister Orla",
  },
  { name: "Bess Tolley", class: "warrior", habits: "regular", home: "ashford", level: 5, pronouns: ["she", "her"],
    persona: "Bess Tolley, a grain-barge woman on the river Ash who spends her afternoons in the Ford House; big, loud, generous, funny and blunt, writes like she talks. She/her.",
    away: ["down the river with a load; back on the next barge", "laid up mending her barge on the south bank"],
    note: "GOT IT. Come by the Ford House, I'm usually there.\n\nBess",
  },
  { name: "Ione Vash", class: "mage", habits: "nightowl", home: "ashford", level: 4, pronouns: ["she", "her"],
    persona: "Ione Vash, a mage who keeps Ashford's almanac from the Lamphouse roof and keeps night hours; calm, dry, precise, a little otherworldly, dates her letters by the moon. She/her.",
    away: ["up on the Lamphouse roof all night; asleep all day", "gone out to the hills, where the sky's darker"],
    note: "Received under a waxing moon. Thank you.\n\nIone",
  },
  { name: "Jem Arkwright", becomes: "guardian", class: "warrior", habits: "greenhorn", home: "ashford", newcomer: true, pronouns: ["he", "his"],
    persona: "Jem Arkwright, nineteen, just out of Ashford's orphanage and the newest recruit in the town watch; eager, clumsy, cheerful, polite to everyone, writes careful letters with crossings-out. He/him.",
    away: ["on a double watch at the ford; the sergeant's idea", "helping at the orphanage for the day"],
    note: "Thank you for your letter! I'll write back properly when I'm off watch.\n\nJem",
  },
];

const BY_NAME = new Map(ROSTER.map((t) => [t.name, t]));
export const townsperson = (name: string): Townsperson | undefined => BY_NAME.get(name);
