import { syntheticBenchmark } from "./fixtures.mjs";
// Written after rejecting relative pruning, before executing final confirmation.
const families = [
  [
    "solar",
    "Solar inverter SI-683",
    "Book electrician Nora to replace solar inverter SI-683 before 17 July. Rooftop panels no longer feed electricity into the house.",
    "Solar panel cleaning",
    "Wash dust from rooftop solar panels; the inverter is healthy.",
    [
      "SI-683",
      "replacing inverters",
      "The rooftop installation has stopped supplying power to my home",
      "электричество solar inverter Nora",
      "solar invertr",
      "Who should replace the inverter before 17 July?",
      "Find my repair plan for restoring the electricity generated on the roof and the person I intended to call.",
      "SI-684 battery warranty",
    ],
  ],
  [
    "jazz",
    "Джазовый фестиваль в Риге",
    "Забронировать поездку в Ригу на джазовый фестиваль 11 апреля. Купить билет на ночной автобус, гостиницу пока не выбирать.",
    "Джазовый альбом",
    "Послушать новый джазовый альбом дома. Поездка не планируется.",
    [
      "Ригу",
      "джазовыми фестивалями",
      "Как добраться на музыкальное событие в латвийскую столицу?",
      "Riga ночной автобус",
      "джазвый фестиваль",
      "Что забронировать перед 11 апреля?",
      "Find the travel idea about listening to live music in Latvia and how I intended to get there overnight.",
      "Рига стоматологический приём",
    ],
  ],
  [
    "harbor",
    "Harbor gate key HG-517",
    "Return harbor gate key HG-517 to caretaker Emil after moving the sailboat on 6 February.",
    "Harbor sailboat painting",
    "Repaint the sailboat at the harbor in summer. No key exchange is needed.",
    [
      "HG-517",
      "returning keys",
      "Give the marina access item back after relocating the sailing vessel",
      "harbor ключ Emil",
      "harbr gate key",
      "Who receives the key after 6 February?",
      "Find the errand about handing back the small item used to open the marina entrance once the boat is moved.",
      "HG-518 yacht insurance",
    ],
  ],
  [
    "cheese",
    "Созревание сыра в погребе",
    "Проверить влажность погреба для созревания сыра. Установить гигрометр HY-380 и записывать показания каждую неделю.",
    "Покупка сыра",
    "Купить сыр для бутербродов на вокзале. Хранение в погребе не требуется.",
    [
      "HY-380",
      "созреванием сыров",
      "Контроль сырости там, где выдерживаются молочные головки",
      "humidity сыр погреб",
      "созревание сра",
      "Какой прибор установить в погребе?",
      "Find the monitoring idea for the dampness of the underground room where the dairy products are being aged.",
      "HY-381 морозильная камера",
    ],
  ],
];
const categories = [
  "exact",
  "inflection",
  "semantic",
  "multilingual",
  "typo",
  "question",
  "long",
  "no_answer",
];
export const confirmationBenchmark = {
  version: 1,
  documents: [
    ...syntheticBenchmark.documents,
    ...families.flatMap((f) => [
      { id: f[0] + "-positive", family: f[0], title: f[1], text: f[2] },
      { id: f[0] + "-hard-negative", family: f[0], title: f[3], text: f[4] },
    ]),
  ],
  queries: families.flatMap((f) =>
    f[5].map((query, i) => ({
      id: f[0] + "-" + i,
      split: "confirm",
      family: f[0],
      category: categories[i],
      query,
      relevance: i === 7 ? {} : { [f[0] + "-positive"]: 3 },
    })),
  ),
};
