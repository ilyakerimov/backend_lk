const { sql } = require('@vercel/postgres');
require('dotenv').config();

async function migrate() {
    try {
        console.log('Начинаю миграцию...');

        // Создание таблиц (если не существуют)
        await sql`
            CREATE TABLE IF NOT EXISTS teachers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                avatar TEXT
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                username TEXT UNIQUE,
                avatar TEXT,
                balance INTEGER DEFAULT 0
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                day TEXT,
                time TEXT
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS group_students (
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                PRIMARY KEY (group_id, student_id)
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS lessons (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                date TEXT NOT NULL,
                amount INTEGER NOT NULL
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                date TEXT NOT NULL,
                description TEXT,
                lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL
            )
        `;

        // Удаляем старую таблицу makeups, если она существовала (чтобы пересоздать с новой структурой)
        await sql`DROP TABLE IF EXISTS makeups CASCADE`;

        // НОВАЯ ТАБЛИЦА: отработки (соответствует новому API)
        await sql`
            CREATE TABLE makeups (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
                teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                time TIME,
                amount DECIMAL(10,2) DEFAULT 0,
                description TEXT,
                status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled'))
            )
        `;

        // Добавляем поле makeup_id в таблицу transactions (если ещё нет)
        await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS makeup_id INTEGER REFERENCES makeups(id) ON DELETE SET NULL`;

        // Индексы для производительности
        await sql`CREATE INDEX IF NOT EXISTS idx_groups_teacher ON groups(teacher_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_group_students_group ON group_students(group_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_group_students_student ON group_students(student_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_transactions_student ON transactions(student_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_transactions_lesson ON transactions(lesson_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_transactions_makeup ON transactions(makeup_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_lessons_group ON lessons(group_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_makeups_student ON makeups(student_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_makeups_group ON makeups(group_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_makeups_teacher ON makeups(teacher_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_makeups_status ON makeups(status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_makeups_date ON makeups(date)`;

        // Начальные данные (только если таблицы пусты)
        const teachersCount = await sql`SELECT COUNT(*) FROM teachers`;
        if (teachersCount.rows[0].count === '0') {
            await sql`
                INSERT INTO teachers (name, avatar) VALUES
                    ('Илья Керимов', '/images/ilya.jpg'),
                    ('Альбина Керимова', '/images/albina.jpg')
            `;
        }

        const studentsCount = await sql`SELECT COUNT(*) FROM students`;
        if (studentsCount.rows[0].count === '0') {
            await sql`
                INSERT INTO students (name, username, avatar, balance) VALUES
                    ('Иван Петров', '@ivan', NULL, 5000),
                    ('Мария Смирнова', '@maria', NULL, 3000),
                    ('Алексей Сидоров', '@alex', NULL, 2000)
            `;
        }

        const groupsCount = await sql`SELECT COUNT(*) FROM groups`;
        if (groupsCount.rows[0].count === '0') {
            await sql`
                INSERT INTO groups (title, teacher_id, day, time) VALUES
                    ('Группа A', 1, 'Сб', '10:00 – 11:30'),
                    ('Группа Б', 1, 'Вт', '12:00 – 13:30'),
                    ('Группа В', 2, 'Чт', '15:00 – 16:30')
            `;
        }

        const groupStudentsCount = await sql`SELECT COUNT(*) FROM group_students`;
        if (groupStudentsCount.rows[0].count === '0') {
            await sql`
                INSERT INTO group_students (group_id, student_id) VALUES
                    (1, 1), (1, 2),
                    (2, 3)
            `;
        }

        console.log('Миграция завершена успешно!');
    } catch (err) {
        console.error('Ошибка миграции:', err);
    } finally {
        process.exit();
    }
}

migrate();