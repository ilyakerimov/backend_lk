const express = require('express');
const { sql } = require('@vercel/postgres');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Существующие API эндпоинты ----------
// (без изменений, сохранены из исходного кода)
app.get('/api/teachers', async (req, res) => {
    try {
        const { rows } = await sql`SELECT id, name, avatar FROM teachers`;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/api/lessons', async (req, res) => {
    const { group_id, amount, date } = req.body;
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

        const studentsResult = await sql`
            SELECT student_id FROM group_students WHERE group_id = ${group_id}
        `;
        const studentIds = studentsResult.rows.map(r => r.student_id);

        if (studentIds.length === 0) {
            await sql`COMMIT`;
            return res.json({ lessonId, message: 'В группе нет учеников' });
        }

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

        await sql`COMMIT`;
        res.json({ lessonId, message: 'Занятие проведено' });
    } catch (err) {
        await sql`ROLLBACK`;
        res.status(500).json({ error: err.message });
    }
});

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
            `;
            rows = result.rows;
        } else {
            const result = await sql`SELECT * FROM students`;
            rows = result.rows;
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/students/:id/transactions', async (req, res) => {
    const studentId = req.params.id;
    try {
        const { rows } = await sql`
            SELECT * FROM transactions
            WHERE student_id = ${studentId}
            ORDER BY date DESC
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

app.get('/api/statistics', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        const lessonsCountResult = await sql`
            SELECT COUNT(*) as count
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const totalEarnedResult = await sql`
            SELECT SUM(l.amount) as total
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const studentsCountResult = await sql`
            SELECT COUNT(DISTINCT s.id) as count
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const totalDebtResult = await sql`
            SELECT SUM(CASE WHEN s.balance < 0 THEN s.balance ELSE 0 END) as total
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        res.json({
            lessonsCount: lessonsCountResult.rows[0]?.count || 0,
            totalEarned: totalEarnedResult.rows[0]?.total || 0,
            studentsCount: studentsCountResult.rows[0]?.count || 0,
            totalDebt: totalDebtResult.rows[0]?.total || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- НОВЫЕ ЭНДПОИНТЫ (makeups & schedule) ----------

// GET /api/makeups?teacher_id=...&status=...
app.get('/api/makeups', async (req, res) => {
    const teacherId = req.query.teacher_id;
    const status = req.query.status;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        let query = sql`
            SELECT m.*, s.name as student_name, g.title as group_title
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            LEFT JOIN groups g ON m.group_id = g.id
            WHERE m.teacher_id = ${teacherId}
        `;
        if (status) {
            query = sql`${query} AND m.status = ${status}`;
        }
        query = sql`${query} ORDER BY m.date DESC, m.time DESC`;
        const { rows } = await query;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/makeups
app.post('/api/makeups', async (req, res) => {
    const { student_id, group_id, teacher_id, date, time, amount, description, status } = req.body;
    if (!student_id || !teacher_id || !date) {
        return res.status(400).json({ error: 'student_id, teacher_id и date обязательны' });
    }

    try {
        const { rows } = await sql`
            INSERT INTO makeups (student_id, group_id, teacher_id, date, time, amount, description, status)
            VALUES (${student_id}, ${group_id || null}, ${teacher_id}, ${date}, ${time || null}, ${amount || 0}, ${description || null}, ${status || 'scheduled'})
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/makeups/:id
app.put('/api/makeups/:id', async (req, res) => {
    const { id } = req.params;
    const { student_id, group_id, teacher_id, date, time, amount, description, status } = req.body;

    try {
        // Получаем текущее состояние отработки
        const currentResult = await sql`SELECT * FROM makeups WHERE id = ${id}`;
        if (currentResult.rowCount === 0) {
            return res.status(404).json({ error: 'Отработка не найдена' });
        }
        const current = currentResult.rows[0];

        // Обновляем запись
        const updateResult = await sql`
            UPDATE makeups
            SET 
                student_id = COALESCE(${student_id}, student_id),
                group_id = COALESCE(${group_id}, group_id),
                teacher_id = COALESCE(${teacher_id}, teacher_id),
                date = COALESCE(${date}, date),
                time = COALESCE(${time}, time),
                amount = COALESCE(${amount}, amount),
                description = COALESCE(${description}, description),
                status = COALESCE(${status}, status)
            WHERE id = ${id}
            RETURNING *
        `;

        // Если статус изменился на 'completed' и раньше был не 'completed', списываем деньги
        if (status === 'completed' && current.status !== 'completed') {
            const amountToCharge = amount !== undefined ? amount : current.amount;
            if (amountToCharge > 0) {
                await sql`BEGIN`;
                try {
                    await sql`
                        UPDATE students
                        SET balance = balance - ${amountToCharge}
                        WHERE id = ${current.student_id}
                    `;
                    await sql`
                        INSERT INTO transactions (student_id, amount, date, description, makeup_id)
                        VALUES (${current.student_id}, ${-amountToCharge}, ${date || current.date}, 'Списание за отработку', ${id})
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

// DELETE /api/makeups/:id
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

// GET /api/schedule?teacher_id=...&start=...&end=...
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
                g.title as group_title,
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
                NULL as group_title,
                s.name as student_name,
                m.date,
                m.time,
                m.amount,
                m.status
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            WHERE m.teacher_id = ${teacherId}
                AND m.date BETWEEN ${start} AND ${end}
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

// Экспортируем для Vercel
module.exports = app;