// server.js
// Corrected and simplified Slack Bolt + Postgres example
const { App, ExpressReceiver } = require('@slack/bolt');
const { Pool } = require('pg');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !DATABASE_URL) {
  console.error('Missing required environment variables. Set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and DATABASE_URL.');
  process.exit(1);
}

// Create an ExpressReceiver for Bolt
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  // By default Bolt mounts at /slack/events. If you need a different path set "endpoints"
});

// Create the Bolt App using the receiver
const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

// Postgres pool — Render provides DATABASE_URL env var
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render requires this in production; if not needed in your dev env you can remove
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize DB table
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_text TEXT NOT NULL,
      due_date DATE NOT NULL,
      created_by TEXT,
      channel_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      completed BOOLEAN DEFAULT FALSE
    );
  `);
}
initDB().catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

// ------------------ /addtask command ------------------
app.command('/addtask', async ({ ack, body, client }) => {
  await ack(); // acknowledge immediately

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'add_task_view',
        title: { type: 'plain_text', text: 'Add Task' },
        submit: { type: 'plain_text', text: 'Save' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'task_block',
            label: { type: 'plain_text', text: 'Task' },
            element: { type: 'plain_text_input', action_id: 'task_input', multiline: true }
          },
          {
            type: 'input',
            block_id: 'date_block',
            label: { type: 'plain_text', text: 'Due date (YYYY-MM-DD)' },
            element: { type: 'plain_text_input', action_id: 'date_input' }
          }
        ]
      }
    });
  } catch (err) {
    console.error('Error opening addtask modal:', err);
  }
});

app.view('add_task_view', async ({ ack, view, body, client }) => {
  await ack();

  const user = body.user.id;
  const taskText = view.state.values?.task_block?.task_input?.value || '';
  const dueDateRaw = view.state.values?.date_block?.date_input?.value || '';

  // Basic validation for date (YYYY-MM-DD)
  if (!taskText || !/^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
    try {
      await client.chat.postEphemeral({
        channel: user,
        user,
        text: 'Task not saved. Ensure you provided a task and date in YYYY-MM-DD format.'
      });
    } catch (e) { console.error('error sending ephemeral', e); }
    return;
  }

  try {
    await pool.query(
      `INSERT INTO tasks (user_id, task_text, due_date, created_by) VALUES ($1,$2,$3,$4)`,
      [user, taskText, dueDateRaw, user]
    );

    await client.chat.postMessage({
      channel: user,
      text: `✅ Your task was saved:\n*${taskText}*\nDue: ${dueDateRaw}`
    });
  } catch (err) {
    console.error('DB insert or DM error', err);
    try {
      await client.chat.postEphemeral({ channel: user, user, text: 'Failed to save task (server error).' });
    } catch (e) { console.error('ephemeral send failed', e); }
  }
});

// ------------------ /reminduser command ------------------
app.command('/reminduser', async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'send_reminder_view',
        title: { type: 'plain_text', text: 'Send Reminder' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'input',
            block_id: 'user_select_block',
            label: { type: 'plain_text', text: 'Select user' },
            element: {
              type: 'users_select',
              action_id: 'user_select'
            }
          },
          {
            type: 'input',
            block_id: 'task_select_block',
            label: { type: 'plain_text', text: 'Select task' },
            element: {
              type: 'external_select',
              action_id: 'task_select',
              placeholder: { type: 'plain_text', text: 'Search tasks (select a user first)' }
            }
          },
          {
            type: 'input',
            block_id: 'custom_message_block',
            label: { type: 'plain_text', text: 'Optional message' },
            element: {
              type: 'plain_text_input',
              action_id: 'custom_message',
              multiline: true
            },
            optional: true
          }
        ]
      }
    });
  } catch (err) {
    console.error('open remind modal error', err);
  }
});

// ------------------ options handler for external_select ------------------
// Slack will call this endpoint to get options for 'task_select'.
// We look into the view state to find which user is selected.
app.options('task_select', async ({ ack, body }) => {
  try {
    // Defensive: find selected user in body.view.state.values if available
    let selectedUser;
    if (body.view && body.view.state && body.view.state.values) {
      const values = body.view.state.values;
      for (const blockId of Object.keys(values)) {
        const block = values[blockId];
        for (const actionId of Object.keys(block)) {
          const val = block[actionId];
          if (val && val.type === 'users_select' && val.selected_user) {
            selectedUser = val.selected_user;
            break;
          }
        }
        if (selectedUser) break;
      }
    }

    if (!selectedUser) {
      // Ask the user to pick a user first
      await ack({
        options: [
          { text: { type: 'plain_text', text: 'Please select a user first' }, value: 'no_user' }
        ]
      });
      return;
    }

    // Query tasks for user
    const res = await pool.query(
      `SELECT id, task_text, due_date FROM tasks WHERE user_id=$1 AND completed = false ORDER BY due_date ASC LIMIT 50`,
      [selectedUser]
    );

    if (res.rowCount === 0) {
      await ack({
        options: [
          { text: { type: 'plain_text', text: 'No tasks found for that user' }, value: 'no_tasks' }
        ]
      });
      return;
    }

    const options = res.rows.map(r => {
      // format due_date to YYYY-MM-DD (safe even if it's a string)
      const due = (r.due_date instanceof Date) ? r.due_date.toISOString().slice(0, 10) : String(r.due_date);
      const label = `${r.task_text}`.length > 75 ? `${r.task_text.slice(0,72)}...` : r.task_text;
      const text = `${label} — due ${due}`;
      return { text: { type: 'plain_text', text }, value: String(r.id) };
    });

    await ack({ options });
  } catch (err) {
    console.error('options handler error', err);
    await ack({
      options: [
        { text: { type: 'plain_text', text: 'Error loading tasks' }, value: 'err' }
      ]
    });
  }
});

// ------------------ handle reminder submission ------------------
app.view('send_reminder_view', async ({ ack, view, body, client }) => {
  await ack();

  const ceo = body.user.id;

  const userSelected = view.state.values?.user_select_block?.user_select?.selected_user;
  const taskOption = view.state.values?.task_select_block?.task_select?.selected_option;
  const taskId = taskOption ? taskOption.value : null;
  const customMsg = view.state.values?.custom_message_block?.custom_message?.value || '';

  if (!userSelected || !taskId) {
    try {
      await client.chat.postEphemeral({ channel: ceo, user: ceo, text: 'Please select both a user and a task.' });
    } catch (e) { console.error('ephemeral send failed', e); }
    return;
  }

  try {
    const res = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (res.rowCount === 0) {
      await client.chat.postEphemeral({ channel: ceo, user: ceo, text: 'Task not found (may have been deleted).' });
      return;
    }
    const task = res.rows[0];
    const due = task.due_date instanceof Date ? task.due_date.toISOString().slice(0, 10) : String(task.due_date);

    const text = `🔔 *Reminder* about your task:\n*${task.task_text}*\nDue: ${due}\n\n${customMsg || ''}`;

    await client.chat.postMessage({ channel: userSelected, text, mrkdwn: true });

    await client.chat.postEphemeral({ channel: ceo, user: ceo, text: `Reminder sent to <@${userSelected}> for task id ${taskId}.` });
  } catch (err) {
    console.error('send reminder error', err);
    try {
      await client.chat.postEphemeral({ channel: ceo, user: ceo, text: 'Failed to send reminder (server error).' });
    } catch (e) { console.error('ephemeral error', e); }
  }
});

// Root route for quick health check
receiver.app.get('/', (req, res) => {
  res.send('Slack reminder bot is running.');
});

// Start the HTTP server using the receiver's express app
receiver.app.listen(PORT, () => {
  console.log(`⚡️ Slack Bolt receiver listening on port ${PORT}`);
});
