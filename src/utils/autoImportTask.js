class AutoImportTask {
  constructor() {
    this.tasks = {};
    this.callback = function(data, nextInvocation){

    }
  }

  // Set callback function
  setCallBack(cb) {
    this.callback = cb;
  }

  // Add or update task
  addOrUpdateTask(task) {
    const { auto_import_id, intervals, data } = task;

    // If the task already exists and the interval time has not changed, only update the data
    if (this.tasks[auto_import_id]) {
      if (this.tasks[auto_import_id].intervals === intervals) {
        this.tasks[auto_import_id].data = data;
        return;
      } else {
        // If the interval time has changed, delete the old task
        this.removeTask(auto_import_id);
      }
    }

    // Create and add new task
    this.tasks[auto_import_id] = {
      intervals,
      data,
      intervalId: setInterval(
        () => this.executeTask(auto_import_id),
        intervals * 1000
      ),
      nextInvocation: new Date(Date.now() + intervals * 1000),
    };
  }

  // Remove task
  removeTask(auto_import_id) {
    if (this.tasks[auto_import_id]) {
      clearInterval(this.tasks[auto_import_id].intervalId);
      delete this.tasks[auto_import_id];
    }
  }

  // Execute task
  executeTask(auto_import_id) {
    const task = this.tasks[auto_import_id];
    if (task) {
      console.log(`run [${auto_import_id}] data:`, task.data);

      task.nextInvocation = new Date(Date.now() + task.intervals * 1000);
      if (this.callback){
        this.callback(task.data, task.nextInvocation);
      }
    }
  }

  // Query the next execution time of the task
  queryNextInvocation(auto_import_id) {
    if (this.tasks[auto_import_id]) {
      return this.tasks[auto_import_id].nextInvocation;
    } else {
      return null;
    }
  }

  // Clean up redundant tasks
  cleanUp(tasksList) {
    const ids = tasksList.map((task) => task.auto_import_id);
    const currentIds = Object.keys(this.tasks);
    for (const id of currentIds) {
      if (!ids.includes(id)) {
        this.removeTask(id);
      }
    }
  }

  // Batch query the next execution time of tasks
  queryNextInvocations() {
    return Object.keys(this.tasks).map((auto_import_id) => {
      return {
        auto_import_id: auto_import_id,
        nextInvocations: this.queryNextInvocation(auto_import_id),
      };
    });
  }
}

module.exports = AutoImportTask;