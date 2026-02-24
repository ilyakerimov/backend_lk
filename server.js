const express = require('express');
const { sql } = require('@vercel/postgres');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Проверка существования таблиц ----------
(async () => {
    try {
        // Проверяем и создаем таблицу makeups если нужно
        await sql`
            CREATE TABLE IF NOT EXISTS makeups (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
                teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                time TIME,
                amount INTEGER DEFAULT 0,
                description TEXT,
                status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
                lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL
            );
        `;
        
        // Добавляем поле lesson_id если его нет
        await sql`
            ALTER TABLE makeups 
            ADD COLUMN IF NOT EXISTS lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL
        `;
        
        console.log('Table "makeups" is ready');
    } catch (err) {
        console.error('Error creating table makeups:', err);
    }
})();

// ---------- Преподаватели ----------
app.get('/api/teachers', async (req, res) => {
    try {
        const { rows } = await sql`SELECT id, name, avatar FROM teachers`;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Группы ----------
app.get('/api/groups', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        const { rows } = await sql`
            SELECT g.*, COUNT(gs.student_id) AS students_count
            FROM groups g
            LEFT JOIN group_students gs ON g.id = gs.group_id
            WHERE g.teacher_id = ${teacherId}
            GROUP BY g.id
            ORDER BY g.day, g.time
        `;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups/:id', async (req, res) => {
    const groupId = req.params.id;

    try {
        const groupResult = await sql`SELECT * FROM groups WHERE id = ${groupId}`;
        if (groupResult.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        const group = groupResult.rows[0];

        const studentsResult = await sql`
            SELECT s.id, s.name, s.username, s.avatar, s.balance
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            WHERE gs.group_id = ${groupId}
            ORDER BY s.name
        `;
        group.students = studentsResult.rows;
        res.json(group);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups', async (req, res) => {
    const { title, teacher_id, day, time } = req.body;
    if (!title || !teacher_id) {
        return res.status(400).json({ error: 'title и teacher_id обязательны' });
    }

    try {
        const { rows } = await sql`
            INSERT INTO groups (title, teacher_id, day, time)
            VALUES (${title}, ${teacher_id}, ${day || null}, ${time || null})
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/groups/:id', async (req, res) => {
    const { title, day, time } = req.body;
    const groupId = req.params.id;

    try {
        const result = await sql`
            UPDATE groups
            SET title = ${title}, day = ${day}, time = ${time}
            WHERE id = ${groupId}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/groups/:id', async (req, res) => {
    const groupId = req.params.id;

    try {
        const result = await sql`DELETE FROM groups WHERE id = ${groupId}`;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups/:id/students', async (req, res) => {
    const groupId = req.params.id;
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id обязателен' });

    try {
        await sql`
            INSERT INTO group_students (group_id, student_id)
            VALUES (${groupId}, ${student_id})
            ON CONFLICT DO NOTHING
        `;
        res.status(201).json({ added: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/groups/:groupId/students/:studentId', async (req, res) => {
    const { groupId, studentId } = req.params;

    try {
        const result = await sql`
            DELETE FROM group_students
            WHERE group_id = ${groupId} AND student_id = ${studentId}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Запись не найдена' });
        }
        res.json({ removed: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Занятия ----------
app.post('/api/lessons', async (req, res) => {
    const { group_id, amount, date, present_student_ids } = req.body;
    if (!group_id || !amount || !date) {
        return res.status(400).json({ error: 'group_id, amount и date обязательны' });
    }

    try {
        await sql`BEGIN`;

        const lessonResult = await sql`
            INSERT INTO lessons (group_id, date, amount)
            VALUES (${group_id}, ${date}, ${amount})
            RETURNING id
        `;
        const lessonId = lessonResult.rows[0].id;

        // Если передан список присутствующих, используем его, иначе всех учеников группы
        let studentIds = present_student_ids;
        if (!studentIds || studentIds.length === 0) {
            const studentsResult = await sql`
                SELECT student_id FROM group_students WHERE group_id = ${group_id}
            `;
            studentIds = studentsResult.rows.map(r => r.student_id);
        }

        if (studentIds.length > 0) {
            // Списываем деньги только с присутствующих
            for (const studentId of studentIds) {
                await sql`
                    UPDATE students
                    SET balance = balance - ${amount}
                    WHERE id = ${studentId}
                `;

                await sql`
                    INSERT INTO transactions (student_id, amount, date, description, lesson_id)
                    VALUES (${studentId}, ${-amount}, ${date}, 'Списание за занятие', ${lessonId})
                `;
            }
        }

        // Создаем отработки для отсутствующих (если есть список присутствующих)
        if (present_student_ids && present_student_ids.length > 0) {
            // Получаем всех учеников группы
            const allStudentsResult = await sql`
                SELECT student_id FROM group_students WHERE group_id = ${group_id}
            `;
            const allStudentIds = allStudentsResult.rows.map(r => r.student_id);
            
            // Отсутствующие = все - присутствующие
            const absentIds = allStudentIds.filter(id => !studentIds.includes(id));
            
            // Создаем отработки для отсутствующих
            for (const studentId of absentIds) {
                await sql`
                    INSERT INTO makeups (
                        student_id, group_id, teacher_id, date, description, status, lesson_id, amount
                    )
                    VALUES (
                        ${studentId}, 
                        ${group_id}, 
                        (SELECT teacher_id FROM groups WHERE id = ${group_id}), 
                        ${date}, 
                        'Пропуск занятия', 
                        'scheduled',
                        ${lessonId},
                        ${amount}
                    )
                `;
            }
        }

        await sql`COMMIT`;
        res.json({ 
            lessonId, 
            message: 'Занятие проведено',
            absent_count: present_student_ids ? (studentIds ? 0 : 0) : 0
        });
    } catch (err) {
        await sql`ROLLBACK`;
        res.status(500).json({ error: err.message });
    }
});

// ---------- Ученики ----------
app.get('/api/students', async (req, res) => {
    const teacherId = req.query.teacher_id;
    try {
        let rows;
        if (teacherId) {
            const result = await sql`
                SELECT DISTINCT s.*
                FROM students s
                JOIN group_students gs ON s.id = gs.student_id
                JOIN groups g ON gs.group_id = g.id
                WHERE g.teacher_id = ${teacherId}
                ORDER BY s.name
            `;
            rows = result.rows;
        } else {
            const result = await sql`SELECT * FROM students ORDER BY name`;
            rows = result.rows;
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/students/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const { rows } = await sql`SELECT * FROM students WHERE id = ${id}`;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/students', async (req, res) => {
    const { name, username, avatar, balance } = req.body;
    if (!name || !username) {
        return res.status(400).json({ error: 'name и username обязательны' });
    }
    try {
        const { rows } = await sql`
            INSERT INTO students (name, username, avatar, balance)
            VALUES (${name}, ${username}, ${avatar || null}, ${balance || 0})
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Привязать ученика к преподавателю
app.post('/api/students/attach-to-teacher', async (req, res) => {
    const { student_id, teacher_id } = req.body;
    if (!student_id || !teacher_id) {
        return res.status(400).json({ error: 'student_id и teacher_id обязательны' });
    }

    try {
        // Проверяем, есть ли у преподавателя группа "Все ученики" или создаем её
        let groupResult = await sql`
            SELECT id FROM groups 
            WHERE teacher_id = ${teacher_id} AND title = 'Все ученики'
        `;
        
        let groupId;
        if (groupResult.rowCount === 0) {
            // Создаем группу для хранения всех учеников преподавателя
            const newGroup = await sql`
                INSERT INTO groups (title, teacher_id, day, time)
                VALUES ('Все ученики', ${teacher_id}, NULL, NULL)
                RETURNING id
            `;
            groupId = newGroup.rows[0].id;
        } else {
            groupId = groupResult.rows[0].id;
        }

        // Привязываем ученика к группе
        await sql`
            INSERT INTO group_students (group_id, student_id)
            VALUES (${groupId}, ${student_id})
            ON CONFLICT DO NOTHING
        `;

        res.json({ attached: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/students/:id', async (req, res) => {
    const { name, username, avatar, balance } = req.body;
    const id = req.params.id;
    try {
        const result = await sql`
            UPDATE students
            SET name = ${name}, username = ${username}, avatar = ${avatar}, balance = ${balance}
            WHERE id = ${id}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/students/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const result = await sql`DELETE FROM students WHERE id = ${id}`;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Транзакции ----------
app.get('/api/students/:id/transactions', async (req, res) => {
    const studentId = req.params.id;
    try {
        const { rows } = await sql`
            SELECT * FROM transactions
            WHERE student_id = ${studentId}
            ORDER BY date DESC, id DESC
        `;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/students/:id/transactions', async (req, res) => {
    const studentId = req.params.id;
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount обязателен' });

    const date = new Date().toISOString().slice(0, 10);
    try {
        await sql`BEGIN`;

        await sql`
            UPDATE students
            SET balance = balance + ${amount}
            WHERE id = ${studentId}
        `;

        const transactionResult = await sql`
            INSERT INTO transactions (student_id, amount, date, description)
            VALUES (${studentId}, ${amount}, ${date}, ${description || 'Пополнение счета'})
            RETURNING id
        `;

        await sql`COMMIT`;
        res.status(201).json({ transactionId: transactionResult.rows[0].id });
    } catch (err) {
        await sql`ROLLBACK`;
        res.status(500).json({ error: err.message });
    }
});

// ---------- Статистика ----------
app.get('/api/statistics', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        // Количество проведенных занятий
        const lessonsCountResult = await sql`
            SELECT COUNT(*) as count
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        // Сумма заработанного
        const totalEarnedResult = await sql`
            SELECT COALESCE(SUM(l.amount * (
                SELECT COUNT(*) FROM group_students gs WHERE gs.group_id = l.group_id
            )), 0) as total
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        // Количество уникальных учеников
        const studentsCountResult = await sql`
            SELECT COUNT(DISTINCT s.id) as count
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        // Общая сумма долга
        const totalDebtResult = await sql`
            SELECT COALESCE(SUM(CASE WHEN s.balance < 0 THEN s.balance ELSE 0 END), 0) as total
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        // Количество запланированных отработок
        const pendingMakeupsResult = await sql`
            SELECT COUNT(*) as count
            FROM makeups m
            WHERE m.teacher_id = ${teacherId} AND m.status = 'scheduled'
        `;

        // Количество проведенных отработок
        const completedMakeupsResult = await sql`
            SELECT COUNT(*) as count
            FROM makeups m
            WHERE m.teacher_id = ${teacherId} AND m.status = 'completed'
        `;

        // История занятий (последние 10)
        const recentLessonsResult = await sql`
            SELECT 
                l.id,
                l.date,
                l.amount,
                g.title as group_title,
                COUNT(gs.student_id) as students_count
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            LEFT JOIN group_students gs ON g.id = gs.group_id
            WHERE g.teacher_id = ${teacherId}
            GROUP BY l.id, g.title
            ORDER BY l.date DESC
            LIMIT 10
        `;

        // Топ учеников по посещаемости
        const topStudentsResult = await sql`
            SELECT 
                s.id,
                s.name,
                s.avatar,
                COUNT(DISTINCT l.id) as lessons_attended
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            JOIN lessons l ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
            GROUP BY s.id
            ORDER BY lessons_attended DESC
            LIMIT 5
        `;

        res.json({
            lessonsCount: parseInt(lessonsCountResult.rows[0]?.count) || 0,
            totalEarned: parseInt(totalEarnedResult.rows[0]?.total) || 0,
            studentsCount: parseInt(studentsCountResult.rows[0]?.count) || 0,
            totalDebt: parseInt(totalDebtResult.rows[0]?.total) || 0,
            pendingMakeups: parseInt(pendingMakeupsResult.rows[0]?.count) || 0,
            completedMakeups: parseInt(completedMakeupsResult.rows[0]?.count) || 0,
            recentLessons: recentLessonsResult.rows,
            topStudents: topStudentsResult.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Отработки ----------
app.get('/api/makeups', async (req, res) => {
    const teacherId = req.query.teacher_id;
    const status = req.query.status;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        let query = `
            SELECT 
                m.*, 
                s.name as student_name, 
                s.avatar as student_avatar,
                g.title as group_title,
                l.date as lesson_date
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            LEFT JOIN groups g ON m.group_id = g.id
            LEFT JOIN lessons l ON m.lesson_id = l.id
            WHERE m.teacher_id = $1
        `;
        const params = [teacherId];
        let paramIndex = 2;

        if (status && status !== 'all') {
            query += ` AND m.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        query += ` ORDER BY m.date DESC, m.time DESC`;

        const { rows } = await sql.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/makeups', async (req, res) => {
    const { student_id, group_id, teacher_id, date, time, amount, description, status, lesson_id } = req.body;
    if (!student_id || !teacher_id || !date) {
        return res.status(400).json({ error: 'student_id, teacher_id и date обязательны' });
    }

    try {
        const { rows } = await sql`
            INSERT INTO makeups (
                student_id, group_id, teacher_id, date, time, amount, description, status, lesson_id
            )
            VALUES (
                ${student_id}, 
                ${group_id || null}, 
                ${teacher_id}, 
                ${date}::DATE, 
                ${time || null}::TIME, 
                ${amount || 0}, 
                ${description || null}, 
                ${status || 'scheduled'},
                ${lesson_id || null}
            )
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/makeups/:id', async (req, res) => {
    const { id } = req.params;
    const { student_id, group_id, teacher_id, date, time, amount, description, status } = req.body;

    try {
        const currentResult = await sql`SELECT * FROM makeups WHERE id = ${id}`;
        if (currentResult.rowCount === 0) {
            return res.status(404).json({ error: 'Отработка не найдена' });
        }
        const current = currentResult.rows[0];

        const updateResult = await sql`
            UPDATE makeups
            SET 
                student_id = COALESCE(${student_id}, student_id),
                group_id = COALESCE(${group_id}, group_id),
                teacher_id = COALESCE(${teacher_id}, teacher_id),
                date = COALESCE(${date}::DATE, date),
                time = COALESCE(${time}::TIME, time),
                amount = COALESCE(${amount}, amount),
                description = COALESCE(${description}, description),
                status = COALESCE(${status}, status)
            WHERE id = ${id}
            RETURNING *
        `;

        if (status === 'completed' && current.status !== 'completed') {
            const amountToCharge = amount !== undefined ? amount : (current.amount || 0);
            if (amountToCharge > 0) {
                await sql`BEGIN`;
                try {
                    await sql`
                        UPDATE students
                        SET balance = balance - ${amountToCharge}
                        WHERE id = ${current.student_id}
                    `;
                    await sql`
                        INSERT INTO transactions (
                            student_id, amount, date, description, makeup_id
                        )
                        VALUES (
                            ${current.student_id}, 
                            ${-amountToCharge}, 
                            ${date || current.date}, 
                            'Списание за отработку', 
                            ${id}
                        )
                    `;
                    await sql`COMMIT`;
                } catch (err) {
                    await sql`ROLLBACK`;
                    throw err;
                }
            }
        }

        res.json({ updated: true, makeup: updateResult.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/makeups/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const makeup = await sql`SELECT status FROM makeups WHERE id = ${id}`;
        if (makeup.rowCount === 0) {
            return res.status(404).json({ error: 'Отработка не найдена' });
        }
        if (makeup.rows[0].status === 'completed') {
            return res.status(400).json({ error: 'Нельзя удалить проведенную отработку' });
        }

        const result = await sql`DELETE FROM makeups WHERE id = ${id}`;
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Пропущенные занятия ----------
app.get('/api/missed-lessons', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        const { rows } = await sql`
            SELECT DISTINCT
                l.id as lesson_id,
                l.date,
                l.amount,
                g.id as group_id,
                g.title as group_title,
                s.id as student_id,
                s.name as student_name,
                s.avatar as student_avatar
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            JOIN group_students gs ON g.id = gs.group_id
            JOIN students s ON gs.student_id = s.id
            LEFT JOIN makeups m ON m.lesson_id = l.id AND m.student_id = s.id
            WHERE g.teacher_id = ${teacherId}
                AND m.id IS NULL
                AND l.date < CURRENT_DATE::TEXT
            ORDER BY l.date DESC
        `;
        res.json(rows);
    } catch (err) {
        console.error('Error in missed-lessons:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Расписание ----------
app.get('/api/schedule', async (req, res) => {
    const teacherId = req.query.teacher_id;
    const start = req.query.start;
    const end = req.query.end;
    if (!teacherId || !start || !end) {
        return res.status(400).json({ error: 'teacher_id, start и end обязательны' });
    }

    try {
        const lessons = await sql`
            SELECT 
                l.id,
                'lesson' as type,
                g.title as title,
                NULL as student_name,
                l.date,
                g.time,
                l.amount,
                NULL as status
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
                AND l.date BETWEEN ${start} AND ${end}
        `;

        const makeups = await sql`
            SELECT 
                m.id,
                'makeup' as type,
                CONCAT('Отработка: ', s.name) as title,
                s.name as student_name,
                m.date,
                m.time,
                m.amount,
                m.status
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            WHERE m.teacher_id = ${teacherId}
                AND m.date BETWEEN ${start}::DATE AND ${end}::DATE
        `;

        const schedule = [...lessons.rows, ...makeups.rows];
        schedule.sort((a, b) => {
            if (a.date < b.date) return -1;
            if (a.date > b.date) return 1;
            const timeA = a.time || '00:00:00';
            const timeB = b.time || '00:00:00';
            return timeA.localeCompare(timeB);
        });

        res.json(schedule);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;