import test from "node:test";
import assert from "node:assert/strict";
import { isArchitecturalObservation, isPlanObservation, routeIntent } from "../lib/graceIntent.js";

const graceMessages = [
  "@grace", "Hi, @Grace!", "(@GRACE): start", "@grace, начнём", "@грейс!",
  "＠Ｇｒａｃｅ", "Grace Plan", "GRACE PLAN: start",
  "Новый проект", "НОВЫЙ ПЛАН", "Почнімо новий проєкт", "Новий проект",
  "Нова проєктна пропозиція", "Сделай проектное предложение", "Проектного предложения достаточно",
  "Підготуй проєктну пропозицію", "new plan", "Start a NEW PROJECT", "Prepare a project proposal",
  "погнали", "Погнали!", "Ну что, погнали!",
  "Edit the plan", "Update this layout", "Измени этот план", "Зміни цей план",
  "pdf", "Make a PDF", "ПДФ", "Сделай комплект 6×А2", "Generate renders", "Сделай рендер",
  "Create a 3D model", "Нужна 2D модель",
  "floor plan", "FLOOR-PLAN", "Plan of the building", "house design", "Architectural drawing",
  "План этажа", "ПЛАН ПОВЕРХУ", "План приміщення", "План будинку", "Перепланировка",
  "Перепланування", "Отделка комнаты", "Оздоблення кімнати", "Матеріали фасаду",
  "Move the door", "Add windows", "Design the office lighting", "BIM", "IFC",
  "CCTV", "NAS", "Configure NVR", "Security camera placement", "access control",
  "Design the Wi-Fi coverage", "Cable layout", "Расстановка камер", "Відеоспостереження",
  "Схема кабелей", "План мережі", "Контроль доступу",
  "Смотри на фото https://example.com/reference.jpg",
  "Дивись на фото: https://example.com/album/123",
  "Please analyze these photos: https://example.com/room",
  "Photo URLs: https://example.com/a.jpg https://example.com/b.jpg",
  "Look at the photos", "Подивись на фото",
  "Make a floor plan using source.png", "Make a PDF from draft.txt",
];

for (const text of graceMessages) {
  test(`Grace request: ${text}`, () => {
    const result = routeIntent({ text });
    assert.equal(result.mode, "grace");
    assert.ok(result.reason.length > 0);
    assert.notEqual(result.reason, "grace-follow-up", "must not need a previous Grace session");
  });
}

const generalMessages = [
  "", "Hello", "How are you?", "2 + 2", "What is 12 * 8?", "Calculate 24 / 3",
  "Посчитай 7 × 8", "Обчисли 16 / 2", "Solve the equation x + 2 = 5",
  "What's the weather tomorrow?", "Какая погода?", "Яка погода у Києві?",
  "How do I cook rice?", "Дай рецепт борща", "Погнали готовить борщ",
  "anatomy plan?", "Edit my anatomy study plan", "New plan for my anatomy exam",
  "План изучения анатомии", "Новий план навчання", "business plan", "plan a vacation",
  "Explain the sagittal plane", "The plane lands at noon", "A planet or a plantation?",
  "NASA", "What does NASA do?", "nasal anatomy", "NASCAR", "nas_backup", "NASА",
  "Which camera phone should I buy?", "How do I change camera settings?",
  "Настройки камеры телефона", "Як налаштувати камеру телефона?", "Camera obscura",
  "@graceful", "@Gracefully", "@grace_123", "@grace2", "@graceЖ", "@graceі",
  "@grace\u0301", "hello@grace.com", "имя@grace", "a@Grace", "_@grace", "@@grace",
  "grace", "grace planner", "grace plantation", "superBIM", "рендерингомания",
  "project.pdf", "floor-plan.png", "новый_проект.pdf", "NAS.jpg", "@grace.png",
  "Files: plan.pdf interior.jpg", "https://example.com/floor-plan.png",
  "https://example.com/@grace", "https://example.com/new-project/cctv?format=pdf",
  "What's at https://example.com/cat.jpg?", "my file is NASA.txt",
  "How does React rendering work?", "Edit the Python project", "yes, explain the weather",
  "make dinner", "change my password", "continue cooking", "yes, what is 2 + 2?",
];

for (const text of generalMessages) {
  for (const previousMode of ["general", "grace"]) {
    test(`General request after ${previousMode}: ${text}`, () => {
      assert.deepEqual(routeIntent({ text, previousMode }), {
        mode: "general", reason: "no-grace-intent",
      });
    });
  }
}

const followUps = [
  "yes", "YES!", "да", "так", "ОК", "Okay", "Sure!", "continue", "go on", "next",
  "продолжай", "продолжи", "продовжуй", "далі", "дальше", "давай",
  "make", "make it", "do it", "сделай", "зроби", "change", "change it", "измени", "зміни",
  "Yes, continue!", "Да, сделай", "Так, зроби", "make it larger", "сделай больше", "зроби менше",
  "move this", "remove it", "убери это", "прибери це", "сюда",
  "change coords", "change coordinates to 10, 20", "измени координаты на 12, 25",
  "зміни координати на 3, 7", "change coords: x=10, y=20", "x=12, y=25", "(12, 25)",
];

for (const text of followUps) {
  test(`Context-limited follow-up: ${text}`, () => {
    assert.deepEqual(routeIntent({ text, previousMode: "grace" }), {
      mode: "grace", reason: "grace-follow-up",
    });
    assert.equal(routeIntent({ text }).mode, "general");
  });
}

const relevantKinds = [
  "floor_plan", "Floor-Plan", "ＦＬＯＯＲ＿ＰＬＡＮ", "2D plan", "2d_floor_plan",
  "floorplan", "floor plan drawing", "architectural plan", "site plan", "blueprint",
  "architectural drawing", "interior", "interior_photo", "interior photograph",
  "room_interior", "room", "exterior", "exterior_photo", "building_exterior", "facade",
  "план", "ПЛАН ЭТАЖА", "план поверху", "план приміщення", "чертёж", "креслення",
  "интерьер", "інтер’єр", "екстер'єр", "фасад", "фото приміщення",
];

for (const kind of relevantKinds) {
  test(`Relevant vision kind: ${kind}`, () => {
    for (const photo of [{ kind }, { name: "cat.jpg", observations: { kind } }]) {
      assert.equal(isArchitecturalObservation(photo), true);
      assert.deepEqual(routeIntent({ observations: [photo] }), {
        mode: "grace", reason: "plan-observation",
      });
    }
  });
}

const otherObservations = [
  null, undefined, false, 1, "floor_plan", [], {},
  { name: "floor_plan.png" }, { name: "interior.jpg", type: "image/jpeg" },
  { name: "новый_проект.pdf", observations: {} },
  { name: "room.jpg", observations: { kind: "cat" } },
  { name: "plan.png", observations: { kind: "screenshot" } },
  { observations: { kind: "general" } }, { observations: { kind: "unknown" } },
  { observations: { kind: "drawing" } }, { observations: { kind: "anatomy plan" } },
  { observations: { kind: "interior_cat" } }, { observations: { kind: "floor planet" } },
  { observations: { kind: "screenshot of floor plan" } },
  { observations: { kind: "general", visible_rooms: ["kitchen"], caption: "floor plan" } },
  { observations: { kind: ["floor_plan"] } }, { observations: { kind: 123 } },
  { observations: { kind: { toString: () => "interior" } } },
  { kind: "interior", observations: { kind: "cat" } },
  { url: "https://example.com/plan.png" },
];

test("floor plans are distinguished from room photographs", () => {
  assert.equal(isPlanObservation({ observations: { kind: "floor_plan" } }), true);
  assert.equal(isPlanObservation({ observations: { kind: "2D plan" } }), true);
  for (const kind of ["interior", "exterior", "corridor", "stairs", "technical", "screenshot", "other"]) {
    assert.equal(isPlanObservation({ observations: { kind } }), false, kind);
  }
  for (const kind of ["interior", "exterior", "corridor", "stairs", "technical"]) {
    assert.equal(routeIntent({ observations: [{ observations: { kind } }] }).mode, "grace");
  }
});

for (const [index, photo] of otherObservations.entries()) {
  test(`Non-design or missing vision evidence #${index + 1}`, () => {
    assert.equal(isPlanObservation(photo), false);
    assert.equal(routeIntent({ observations: [photo] }).mode, "general");
    assert.equal(routeIntent({ text: "2 + 2", observations: [photo], previousMode: "grace" }).mode, "general");
  });
}

test("defaults and malformed optional values stay general", () => {
  assert.deepEqual(routeIntent(), { mode: "general", reason: "no-grace-intent" });
  for (const value of [null, false, 42, {}, ["@grace"]]) {
    assert.equal(routeIntent({ text: value, observations: value }).mode, "general");
  }
  assert.equal(routeIntent({ text: "yes", previousMode: "unknown" }).mode, "general");
});

test("only the supplied current message is routed, never older messages", () => {
  assert.equal(routeIntent({
    text: "2 + 2", previousMode: "grace",
    messages: [{ role: "user", content: "@Grace, new project" }],
    history: "floor plan PDF",
  }).mode, "general");
  const first = routeIntent({ text: "Новый проект" });
  const second = routeIntent({ text: "What's the weather?", previousMode: first.mode });
  assert.equal(first.mode, "grace");
  assert.equal(second.mode, "general");
  assert.equal(routeIntent({ text: "continue", previousMode: second.mode }).mode, "general");
});

test("explicit invocation and actual design evidence take precedence", () => {
  assert.equal(routeIntent({ text: "@Grace: calculate 2 + 2" }).reason, "explicit-grace");
  assert.equal(routeIntent({ text: "floor plan for an anatomy lab" }).reason, "design-topic");
  assert.equal(routeIntent({ text: "weather", observations: [{ kind: "interior" }] }).reason, "plan-observation");
  assert.equal(routeIntent({ observations: [{ kind: "cat" }, { kind: "floor_plan" }] }).reason, "plan-observation");
});

test("follow-ups match the whole short message, not arbitrary prefixes", () => {
  for (const text of [
    "yes, tell me a joke", "change coords and explain astronomy", "make it project.pdf",
    "continue https://example.com/plan.png", "yes ".repeat(30), "x=2 + 2", "continue\nwhat is the capital of France?",
  ]) {
    assert.equal(routeIntent({ text, previousMode: "grace" }).mode, "general", text);
  }
});

test("routing is deterministic and does not mutate its inputs", () => {
  const photo = Object.freeze({ name: "source.jpg", observations: Object.freeze({ kind: "floor_plan" }) });
  const input = Object.freeze({ text: "\tＮｅｗ　Ｐｌａｎ\n", observations: Object.freeze([photo]) });
  const expected = routeIntent(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(routeIntent(input), expected);
  assert.equal(photo.observations.kind, "floor_plan");
  assert.equal(input.text, "\tＮｅｗ　Ｐｌａｎ\n");
  assert.equal(routeIntent({ text: input.text }).mode, "grace");
});
