-- Преподаватели
CREATE TABLE teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar TEXT
);

-- Ученики
CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT UNIQUE,
    avatar TEXT,
    balance INTEGER DEFAULT 0 -- текущий баланс (копейки/рубли)
);

-- Группы
CREATE TABLE groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    teacher_id INTEGER NOT NULL,
    day TEXT,       -- например "Сб", "Вт"
    time TEXT,      -- например "10:00 – 11:30"
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

-- Связь групп и учеников (многие ко многим)
CREATE TABLE group_students (
    group_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, student_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

-- Проведённые занятия
CREATE TABLE lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    date TEXT NOT NULL,           -- дата проведения (YYYY-MM-DD)
    amount INTEGER NOT NULL,      -- сумма списания с каждого ученика (в копейках/рублях)
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- Транзакции учеников (пополнения / списания)
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,      -- положительное – пополнение, отрицательное – списание
    date TEXT NOT NULL,           -- дата операции
    description TEXT,             -- описание (например "Оплата занятия", "Пополнение")
    lesson_id INTEGER,            -- если списание связано с занятием
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
);

-- Индексы для ускорения
CREATE INDEX idx_groups_teacher ON groups(teacher_id);
CREATE INDEX idx_group_students_group ON group_students(group_id);
CREATE INDEX idx_group_students_student ON group_students(student_id);
CREATE INDEX idx_transactions_student ON transactions(student_id);
CREATE INDEX idx_lessons_group ON lessons(group_id);

-- Начальные данные
INSERT INTO teachers (name, avatar) VALUES
    ('Илья Керимов', '/images/ilya.jpg'),
    ('Альбина Керимова', '/images/albina.jpg');
    
INSERT INTO students (name, username, avatar, balance) VALUES
    ('Иван Петров', '@ivan', NULL, 5000),
    ('Мария Смирнова', '@maria', NULL, 3000),
    ('Алексей Сидоров', '@alex', NULL, 2000);

INSERT INTO groups (title, teacher_id, day, time) VALUES
    ('Группа A', 1, 'Сб', '10:00 – 11:30'),
    ('Группа Б', 1, 'Вт', '12:00 – 13:30'),
    ('Группа В', 2, 'Чт', '15:00 – 16:30');

INSERT INTO group_students (group_id, student_id) VALUES
    (1, 1), (1, 2),   -- группа A: Иван, Мария
    (2, 3);           -- группа Б: Алексей