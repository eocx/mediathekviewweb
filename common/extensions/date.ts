interface DateConstructor {
  isValid(year: number, month: number): boolean;
  isValid(year: number, month: number, date: number): boolean;
}

(() => {
  function isValid(year: number, month: number, date?: number): boolean {
    const d = new Date(year, month, date);

    const dateValid = d.getDate() == date;
    const monthValid = d.getMonth() == month;
    const yearValid = d.getFullYear() == year;
    const valid = dateValid && monthValid && yearValid;

    return valid;
  }

  if (Date.isValid == undefined) {
    Date.isValid = isValid;
  }
})();
