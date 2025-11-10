// server.js
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// Render/Heroku-style single process: use ExpressReceiver to share express app
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Create the Bolt App using the receiver (it will use the existing express instance)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Postgres pool — Render provides DATABASE_URL env var
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Ensure tasks table exists
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
initDB().catch(err => console.error('DB init error', err));

// ------------------ Slash command /addtask ------------------
app.command('/addtask', async ({ ack, body, client }) => {
  await ack();

  // Open a modal for the user to enter task and date — view_id not required
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
    console.error('open modal error', err);
  }
});

// Handle submission of add_task_view
app.view('add_task_view', async ({ ack, view, body, client }) => {
  await ack();
  const user = body.user.id;
  const task = view.state.values.task_block.task_input.value;
  const dueDate = view.state.values.date_block.date_input.value;
  const channel = view.private_metadata || null;

  // Save to DB
  try {
    await pool.query('INSERT INTO tasks (user_id, task_text, due_date, created_by, channel_id) VALUES ($1,$2,$3,$4,$5)',
      [user, task, dueDate, user, channel]);
  } catch (err) {
    console.error('DB insert error', err);
  }

  // Optionally notify user
  try {
    await client.chat.postMessage({
      channel: user,
      text: `✅ Your task was saved:\n*${task}*\nDue: ${dueDate}`
    });
  } catch (err) {
    console.error('DM user error', err);
  }
});

// ------------------ Slash command /reminduser ------------------
app.command('/reminduser', async ({ ack, body, client }) => {
  await ack();

  // Open modal for CEO to select a user and then task (task list will be loaded via external options)
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
            },
            optional: false
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

// Provide dynamic options for the task_select external_select
// Bolt uses app.options to respond to options requests
app.options('task_select', async ({ options, ack, body }) => {
  // Expect the modal's state to contain selected user — Slack sends the current view state in body
  try {
    // Find the selected user id in the current view state (if present)
    let selectedUser;
    if (body.view && body.view.state) {
      const vs = body.view.state.values;
      for (const blk in vs) {
        for (const inner in vs[blk]) {
          const val = vs[blk][inner];
          if (val && val.type === 'users_select' && val.selected_user) {
            selectedUser = val.selected_user;
            break;
          }
        }
        if (selectedUser) break;
      }
    }

    if (!selectedUser) {
      // Return an empty list with a helpful message
      await ack({
        options: [
          { text: { type: 'plain_text', text: 'Pick a user first' }, value: 'no_user' }
        ]
      });
      return;
    }

    // Query tasks for the selected user (only incomplete ones)
    const res = await pool.query('SELECT id, task_text, due_date FROM tasks WHERE user_id=$1 AND completed = false ORDER BY due_date ASC LIMIT 50', [selectedUser]);
    const optionsList = res.rows.map(r => {
      const label = `${r.task_text} — due ${r.due_date.toISOString().slice(0,10)}`;
      return { text: { type: 'plain_text', text: label.slice(0,75) }, value: String(r.id) };
    });

    if (optionsList.length === 0) {
      await ack({
        options: [
          { text: { type: 'plain_text', text: 'No tasks for that user' }, value: 'no_tasks' }
        ]
      });
      return;
    }

    await ack({ options: optionsList });
  } catch (err) {
    console.error('options handler error', err);
    await ack({ options: [{ text: { type: 'plain_text', text: 'Error loading tasks' }, value: 'err' }]});
  }
});

// Handle view submission for sending reminder
app.view('send_reminder_view', async ({ ack, view, body, client }) => {
  await ack();

  const ceo = body.user.id;
  const userSelect = view.state.values.user_select_block.user_select.selected_user;
  const taskId = view.state.values.task_select_block.task_select.selected_option && view.state.values.task_select_block.task_select.selected_option.value;
  const customMsg = view.state.values.custom_message_block && view.state.values.custom_message_block.custom_message.value;

  // Fetch task text & due date
  try {
    const res = await pool.query('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (res.rowCount === 0) {
      await client.chat.postEphemeral({ channel: ceo, user: ceo, text: 'Task not found.' });
      return;
    }
    const task = res.rows[0];

    // Construct message
    const text = `🔔 *Reminder* about your task:\n*${task.task_text}*\nDue: ${task.due_date.toISOString().slice(0,10)}\n\n${customMsg || ''}`;

    // DM the user
    await client.chat.postMessage({ channel: userSelect, text, mrkdwn: true });

    // Optional: send confirmation to CEO
    await client.chat.postEphemeral({ channel: ceo, user: ceo, text: `Reminder sent to <@${userSelect}> for task id ${taskId}.` });

  } catch (err) {
    console.error('send reminder error', err);
    await client.chat.postEphemeral({ channel: ceo, user: ceo, text: `Failed to send reminder: ${err.message}` });
  }
});

// Start express server (Bolt's receiver has an express app we can use)
receiver.app.get('/', (req, res) => {
  res.send('Slack reminder bot running.');
});

(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack Bolt app is running on port ${PORT}`);
})();
